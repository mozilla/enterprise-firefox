/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "WasmModuleBackend.h"

#include "ContentAnalysis.h"
#include "ContentAnalysisRuleParser.h"
#include "ExternalAgentBackend.h"
#include "content_analysis/sdk/analysis.pb.h"
#include "js/CharacterEncoding.h"
#include "js/Exception.h"
#include "js/PropertyAndElement.h"
#include "js/Wrapper.h"
#include "mozilla/ErrorResult.h"
#include "mozilla/Logging.h"
#include "mozilla/Preferences.h"
#include "mozilla/Span.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/dom/Promise-inl.h"
#include "mozilla/dom/TypedArray.h"
#include "nsIContentAnalysis.h"
#include "nsIFile.h"
#include "nsIInputStream.h"
#include "nsNetUtil.h"
#include "nsServiceManagerUtils.h"
#include "nsThreadUtils.h"
#include "prio.h"

namespace mozilla::contentanalysis {

#define WASM_RUNNER_CONTRACTID "@mozilla.org/contentanalysis/wasm-runner;1"

// Defined in ContentAnalysis.cpp.
extern LazyLogModule gContentAnalysisLog;

namespace {

// The pref carrying the built-in DLP rule set (the DLPRules JSON), set by the
// DataLossPrevention enterprise policy.
static constexpr char kDlpRulesPref[] = "browser.contentanalysis.dlp_rules";

// Recover the nsresult from a rejected wasm-runner promise. The runner
// rejects with a Components.Exception carrying the failure code in its
// `result`.
static nsresult ExtractExceptionResult(JSContext* aCx,
                                       JS::Handle<JS::Value> aValue) {
  if (!aValue.isObject()) {
    return NS_ERROR_FAILURE;
  }
  JS::Rooted<JSObject*> obj(aCx, js::UncheckedUnwrap(&aValue.toObject()));
  JSAutoRealm ar(aCx, obj);
  JS::Rooted<JS::Value> resultValue(aCx);
  if (!JS_GetProperty(aCx, obj, "result", &resultValue)) {
    JS_ClearPendingException(aCx);
    return NS_ERROR_FAILURE;
  }
  if (!resultValue.isNumber()) {
    return NS_ERROR_FAILURE;
  }
  return static_cast<nsresult>(resultValue.toNumber());
}

// Read a file's contents into aContentBytes. This blocks on file I/O, so it
// must run off the main thread. Returns NS_OK (with aContentBytes left empty)
// for an empty file.
static nsresult ReadFileContents(const nsString& aFilePath,
                                 nsTArray<uint8_t>& aContentBytes) {
  MOZ_ASSERT(!NS_IsMainThread());
  nsCOMPtr<nsIFile> file;
  MOZ_TRY(NS_NewLocalFile(aFilePath, getter_AddRefs(file)));
  int64_t fileSize;
  nsresult rv = file->GetFileSize(&fileSize);
  if (NS_WARN_IF(NS_FAILED(rv))) {
    return rv;
  }
  if (fileSize <= 0) {
    return NS_OK;
  }
  if (NS_WARN_IF(fileSize > INT32_MAX)) {
    return NS_ERROR_FILE_TOO_BIG;
  }
  if (NS_WARN_IF(!aContentBytes.SetLength(fileSize, fallible))) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  nsCOMPtr<nsIInputStream> localInFile;
  rv = NS_NewLocalFileInputStream(getter_AddRefs(localInFile), file,
                                  PR_RDONLY | nsIFile::OS_READAHEAD);
  if (NS_WARN_IF(NS_FAILED(rv))) {
    return rv;
  }
  void* dest = aContentBytes.Elements();
  uint64_t bytesRead = 0;
  rv = NS_ReadInputStreamToBuffer(localInFile, &dest, fileSize, &bytesRead);
  if (NS_WARN_IF(NS_FAILED(rv))) {
    return rv;
  }
  aContentBytes.TruncateLength(bytesRead);
  return NS_OK;
}

}  // namespace

nsresult WasmModuleBackend::EnsureReady() {
  AssertIsOnMainThread();
  nsCOMPtr<nsIContentAnalysisWasmRunner> runner =
      do_GetService(WASM_RUNNER_CONTRACTID);
  if (!runner) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  // Kick off fetching the module now instead of waiting for the first
  // Analyze(), so the console round trip isn't on the critical path of the
  // first real request.
  RefPtr<dom::Promise> promise;
  if (NS_SUCCEEDED(runner->EnsureModuleReady(getter_AddRefs(promise))) &&
      promise) {
    promise->AddCallbacksWithCycleCollectedArgs(
        [](JSContext*, JS::Handle<JS::Value>, ErrorResult&) {},
        [](JSContext*, JS::Handle<JS::Value>, ErrorResult&) {
          MOZ_LOG(gContentAnalysisLog, LogLevel::Warning,
                  ("Failed to prefetch the DLP wasm module at startup"));
        });
  }
  return NS_OK;
}

nsresult WasmModuleBackend::LoadDlpRules(
    nsTArray<RefPtr<nsIContentAnalysisRule>>& aRules) {
  AssertIsOnMainThread();
  nsAutoString rulesJSON;
  nsresult rv = Preferences::GetString(kDlpRulesPref, rulesJSON);
  NS_ENSURE_SUCCESS(rv, rv);

  if (rulesJSON != mCachedRulesJSON) {
    nsTArray<RefPtr<nsIContentAnalysisRule>> parsed;
    // An empty pref means no rules are configured, so there is nothing to
    // enforce and nothing to parse.
    if (!rulesJSON.IsEmpty()) {
      MOZ_TRY(ParseContentAnalysisRules(rulesJSON, parsed));
    }
    mCachedRules = std::move(parsed);
    mCachedRulesJSON = rulesJSON;
  }

  aRules = mCachedRules.Clone();
  return NS_OK;
}

nsresult WasmModuleBackend::Analyze(
    nsCOMPtr<nsIContentAnalysisRequest> aRequest, bool aAutoAcknowledge) {
  AssertIsOnMainThread();
  ++mRequestCount;

  nsCString userActionId;
  MOZ_ALWAYS_SUCCEEDS(aRequest->GetUserActionId(userActionId));

  content_analysis::sdk::ContentAnalysisRequest pbRequest;
  nsresult rv = ConvertRequestToProtobuf(aRequest, &pbRequest);
  NS_ENSURE_SUCCESS(rv, rv);

  size_t size = pbRequest.ByteSizeLong();
  nsTArray<uint8_t> requestBytes;
  if (!requestBytes.SetLength(size, mozilla::fallible)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  if (NS_WARN_IF(!pbRequest.SerializeToArray(requestBytes.Elements(),
                                             static_cast<int>(size)))) {
    return NS_ERROR_FAILURE;
  }

  nsTArray<RefPtr<nsIContentAnalysisRule>> rules;
  rv = LoadDlpRules(rules);
  NS_ENSURE_SUCCESS(rv, rv);

  nsIContentAnalysisRequest::AnalysisType type =
      nsIContentAnalysisRequest::AnalysisType::eUnspecified;
  MOZ_ALWAYS_SUCCEEDS(aRequest->GetAnalysisType(&type));
  switch (type) {
    case nsIContentAnalysisRequest::AnalysisType::eFileAttached:
    case nsIContentAnalysisRequest::AnalysisType::eFileDownloaded:
    case nsIContentAnalysisRequest::AnalysisType::eFileTransfer: {
      // Reading the file blocks, so do it on a background thread and return to
      // the main thread to invoke the runner. Errors are reported the same way
      // the runner's own async failures are: via CancelWithError.
      nsString filePath;
      MOZ_TRY(aRequest->GetFilePath(filePath));
      return NS_DispatchBackgroundTask(NS_NewRunnableFunction(
          __func__,
          [self = RefPtr{this}, requestBytes = std::move(requestBytes),
           rules = std::move(rules), filePath = std::move(filePath),
           userActionId, aAutoAcknowledge]() mutable {
            nsTArray<uint8_t> contentBytes;
            nsresult rv = ReadFileContents(filePath, contentBytes);
            NS_DispatchToMainThread(NS_NewRunnableFunction(
                __func__, [self, rv, requestBytes = std::move(requestBytes),
                           contentBytes = std::move(contentBytes),
                           rules = std::move(rules), userActionId,
                           aAutoAcknowledge]() mutable {
                  AssertIsOnMainThread();
                  if (self->mInert) {
                    // Backend may be swapped out or shutting down
                    return;
                  }
                  RefPtr<ContentAnalysis> owner =
                      ContentAnalysis::GetContentAnalysisFromService();
                  if (!owner) {
                    // Shutting down.
                    return;
                  }
                  if (NS_SUCCEEDED(rv)) {
                    rv = self->InvokeRunner(requestBytes, contentBytes, rules,
                                            userActionId, aAutoAcknowledge);
                  }
                  if (NS_FAILED(rv)) {
                    owner->CancelWithError(nsCString(userActionId), rv);
                  }
                }));
          }));
    }
    case nsIContentAnalysisRequest::AnalysisType::eBulkDataEntry:
    case nsIContentAnalysisRequest::AnalysisType::eDataCopied:
      // text_content is already inline in requestBytes, set above.
      return InvokeRunner(requestBytes, nsTArray<uint8_t>{}, rules,
                          userActionId, aAutoAcknowledge);
    case nsIContentAnalysisRequest::AnalysisType::ePrint: {
      nsTArray<uint8_t> printContent;
      rv = aRequest->GetPrintData(printContent);
      NS_ENSURE_SUCCESS(rv, rv);
      return InvokeRunner(requestBytes, printContent, rules, userActionId,
                          aAutoAcknowledge);
    }
    default:
      // No content to extract for other analysis types.
      return InvokeRunner(requestBytes, nsTArray<uint8_t>{}, rules,
                          userActionId, aAutoAcknowledge);
  }
}

nsresult WasmModuleBackend::Acknowledge(
    nsCOMPtr<nsIContentAnalysisAcknowledgement> aAcknowledgement,
    const nsACString& aRequestToken) {
  // The in-process module has no out-of-process counterparty, so there is
  // nothing to acknowledge.
  return NS_OK;
}

void WasmModuleBackend::CancelUserAction(const nsACString& aUserActionId) {
  // Once the WASM is running there's no way to cancel it, but that's OK because
  // it should run quickly. So the only time this is really useful is if
  // we're reading a file (off the main thread), and we do check
  // WasUserActionCanceled() before calling the WASM. Thus there's nothing
  // to do here.
  MOZ_LOG(gContentAnalysisLog, LogLevel::Info,
          ("WASM DLP user action %s cancelled (but nothing to do)",
           nsCString(aUserActionId).get()));
}

void WasmModuleBackend::HandleWasmResponse(JSContext* aCx,
                                           JS::Handle<JS::Value> aValue,
                                           const nsACString& aUserActionId,
                                           bool aAutoAcknowledge) {
  AssertIsOnMainThread();

  if (mInert) {
    // Backend may be swapped out or shutting down
    return;
  }
  RefPtr<ContentAnalysis> owner =
      ContentAnalysis::GetContentAnalysisFromService();
  if (!owner) {
    // Shutting down.
    return;
  }

  content_analysis::sdk::ContentAnalysisResponse pbResponse;
  dom::RootedSpiderMonkeyInterface<dom::Uint8Array> responseArray(aCx);
  bool parsed = aValue.isObject() && responseArray.Init(&aValue.toObject()) &&
                responseArray.ProcessFixedData([&](const Span<uint8_t>& aData) {
                  return pbResponse.ParseFromArray(
                      aData.Elements(), static_cast<int>(aData.Length()));
                });
  if (!parsed) {
    MOZ_LOG(gContentAnalysisLog, LogLevel::Error,
            ("Failed to parse WASM DLP response into protobuf"));
    mConnectedToAgent = false;
    owner->CancelWithError(nsCString(aUserActionId), NS_ERROR_FAILURE);
    return;
  }

  RefPtr<ContentAnalysisResponse> response = ConvertResponseFromProtobuf(
      std::move(pbResponse), nsCString(aUserActionId));
  if (!response) {
    MOZ_LOG(gContentAnalysisLog, LogLevel::Error,
            ("Failed to parse WASM DLP protobuf response"));
    mConnectedToAgent = false;
    owner->CancelWithError(nsCString(aUserActionId), NS_ERROR_FAILURE);
    return;
  }

  // The module produced a real verdict, so it's genuinely connected.
  mConnectedToAgent = true;
  owner->HandleResponseFromAgent(response, aAutoAcknowledge);
}

nsresult WasmModuleBackend::InvokeRunner(
    const nsTArray<uint8_t>& aRequestBytes,
    const nsTArray<uint8_t>& aContentBytes,
    const nsTArray<RefPtr<nsIContentAnalysisRule>>& aRules,
    const nsACString& aUserActionId, bool aAutoAcknowledge) {
  AssertIsOnMainThread();
  RefPtr<ContentAnalysis> owner =
      ContentAnalysis::GetContentAnalysisFromService();
  if (owner && owner->WasUserActionCanceled(aUserActionId)) {
    // The user action was canceled (e.g. while its file contents were being
    // read off the main thread) before we got a chance to hand it to the
    // module; don't bother spinning up the content process for it now.
    return NS_ERROR_WONT_HANDLE_CONTENT;
  }

  nsCOMPtr<nsIContentAnalysisWasmRunner> runner =
      do_GetService(WASM_RUNNER_CONTRACTID);
  if (!runner) {
    mConnectedToAgent = false;
    return NS_ERROR_NOT_AVAILABLE;
  }

  RefPtr<dom::Promise> promise;
  nsresult rv = runner->Analyze(aRequestBytes, aContentBytes, aRules,
                                getter_AddRefs(promise));
  if (NS_FAILED(rv) || !promise) {
    mConnectedToAgent = false;
    return NS_FAILED(rv) ? rv : NS_ERROR_FAILURE;
  }

  promise->AddCallbacksWithCycleCollectedArgs(
      [self = RefPtr{this}, userActionId = nsCString(aUserActionId),
       aAutoAcknowledge](JSContext* aCx, JS::Handle<JS::Value> aValue,
                         ErrorResult&) {
        self->HandleWasmResponse(aCx, aValue, userActionId, aAutoAcknowledge);
      },
      [self = RefPtr{this}, userActionId = nsCString(aUserActionId)](
          JSContext* aCx, JS::Handle<JS::Value> aValue, ErrorResult&) {
        AssertIsOnMainThread();
        if (self->mInert) {
          // Backend may be swapped out or shutting down
          return;
        }
        RefPtr<ContentAnalysis> owner =
            ContentAnalysis::GetContentAnalysisFromService();
        if (!owner) {
          // Shutting down.
          return;
        }
        nsresult rv = ExtractExceptionResult(aCx, aValue);
        self->mConnectedToAgent = false;
        owner->CancelWithError(nsCString(userActionId), rv);
      });
  return NS_OK;
}

RefPtr<ContentAnalysisBackend::DiagnosticInfoPromise>
WasmModuleBackend::GetDiagnosticInfo() {
  AssertIsOnMainThread();
  // No agent path or signature verification applies to this backend, so just
  // report the module's version in the agent path field instead.
  nsAutoString version;
  nsCOMPtr<nsIContentAnalysisWasmRunner> runner =
      do_GetService(WASM_RUNNER_CONTRACTID);
  if (runner) {
    MOZ_ALWAYS_SUCCEEDS(runner->GetCachedModuleVersion(version));
    version.Insert(u"version ", 0);
  }
  auto info = MakeRefPtr<ContentAnalysisDiagnosticInfo>(
      mConnectedToAgent, std::move(version), false, mRequestCount);
  return DiagnosticInfoPromise::CreateAndResolve(info, __func__);
}

void WasmModuleBackend::Shutdown() {
  AssertIsOnMainThread();
  // Drop any runner promise that resolves after this point
  mInert = true;
}

#undef WASM_RUNNER_CONTRACTID

}  // namespace mozilla::contentanalysis
