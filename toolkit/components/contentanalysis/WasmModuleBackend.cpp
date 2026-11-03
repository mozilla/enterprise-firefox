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
#include "mozilla/StaticPrefs_browser.h"
#include "mozilla/dom/Blob.h"
#include "mozilla/dom/MemoryBlobImpl.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/dom/Promise-inl.h"
#include "mozilla/dom/StreamBlobImpl.h"
#include "mozilla/dom/TypedArray.h"
#include "nsIContentAnalysis.h"
#include "nsIFile.h"
#include "nsIFileStreams.h"
#include "nsNetUtil.h"
#include "nsServiceManagerUtils.h"
#include "nsThreadUtils.h"
#include "xpcpublic.h"

namespace mozilla::contentanalysis {

#define WASM_RUNNER_CONTRACTID "@mozilla.org/contentanalysis/wasm-runner;1"

// Defined in ContentAnalysis.cpp.
extern LazyLogModule gContentAnalysisLog;

namespace {

// The pref carrying the built-in DLP rule set (the DLPRules JSON), set by the
// DataLossPrevention enterprise policy.
static constexpr char kDlpRulesPref[] = "browser.contentanalysis.dlp_rules";

// The largest request or content the module is given.
static uint64_t MaxBytes() {
  return StaticPrefs::browser_contentanalysis_wasm_backend_max_content_bytes();
}

// The largest request or content held in a MemoryBlobImpl that the module is
// given, since MemoryBlobImpl can't stream INT32_MAX bytes or more.
static uint64_t MaxMemoryBlobBytes() {
  return std::min<uint64_t>(MaxBytes(), INT32_MAX - 1);
}

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

// Create a blob for a file without reading its contents; the process running
// the module reads them incrementally through the blob. This is a plain stream
// blob rather than a FileBlobImpl because serializing a file blob queries the
// filesystem on the main thread (e.g. FileBlobImpl::IsDirectory), and the
// module needs none of a file blob's metadata. The stream doesn't open the file
// until it is first read, off the main thread. Getting the size blocks on file
// I/O, so this must run off the main thread.
static nsresult CreateFileBlobImpl(const nsString& aFilePath,
                                   RefPtr<dom::BlobImpl>& aBlobImpl) {
  MOZ_ASSERT(!NS_IsMainThread());
  nsCOMPtr<nsIFile> file;
  MOZ_TRY(NS_NewLocalFile(aFilePath, getter_AddRefs(file)));
  int64_t fileSize;
  nsresult rv = file->GetFileSize(&fileSize);
  if (NS_WARN_IF(NS_FAILED(rv))) {
    return rv;
  }
  if (NS_WARN_IF(fileSize < 0)) {
    return NS_ERROR_FAILURE;
  }
  nsCOMPtr<nsIInputStream> stream;
  rv = NS_NewLocalFileInputStream(getter_AddRefs(stream), file, -1, -1,
                                  nsIFileInputStream::CLOSE_ON_EOF |
                                      nsIFileInputStream::DEFER_OPEN |
                                      nsIFileInputStream::SHARE_DELETE);
  if (NS_WARN_IF(NS_FAILED(rv))) {
    return rv;
  }
  aBlobImpl = dom::StreamBlobImpl::Create(stream.forget(), u""_ns,
                                          static_cast<uint64_t>(fileSize),
                                          u"StreamBlobImpl"_ns);
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
  // If this doesn't succeed, the EnsureModuleReady() call will try again
  // the next time it's called.
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

  // The request can be large, since it carries any pasted text inline, so it is
  // serialized straight into the buffer of a blob that the process running the
  // module reads incrementally. MemoryBlobImpl takes ownership of a malloc'd
  // buffer.
  size_t size = pbRequest.ByteSizeLong();
  if (NS_WARN_IF(!size)) {
    return NS_ERROR_FAILURE;
  }
  if (size > MaxMemoryBlobBytes()) {
    return ReportTooLarge(userActionId, size);
  }
  void* requestBuffer = malloc(size);
  if (!requestBuffer) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  if (NS_WARN_IF(
          !pbRequest.SerializeToArray(requestBuffer, static_cast<int>(size)))) {
    free(requestBuffer);
    return NS_ERROR_FAILURE;
  }
  RefPtr<dom::BlobImpl> request =
      new dom::MemoryBlobImpl(requestBuffer, size, u""_ns);

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
      // Getting the file's metadata blocks, so do it on a background thread and
      // return to the main thread to invoke the runner. Errors are reported the
      // same way the runner's own async failures are: via CancelWithError.
      nsString filePath;
      MOZ_TRY(aRequest->GetFilePath(filePath));
      return NS_DispatchBackgroundTask(NS_NewRunnableFunction(
          __func__, [self = RefPtr{this}, request = std::move(request),
                     rules = std::move(rules), filePath = std::move(filePath),
                     userActionId, aAutoAcknowledge]() mutable {
            RefPtr<dom::BlobImpl> content;
            nsresult rv = CreateFileBlobImpl(filePath, content);
            NS_DispatchToMainThread(NS_NewRunnableFunction(
                __func__,
                [self, rv, request = std::move(request),
                 content = std::move(content), rules = std::move(rules),
                 userActionId, aAutoAcknowledge]() mutable {
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
                    rv = self->InvokeRunner(request, content, rules,
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
      // text_content is already inline in the request, set above.
      return InvokeRunner(request, nullptr, rules, userActionId,
                          aAutoAcknowledge);
    case nsIContentAnalysisRequest::AnalysisType::ePrint: {
      nsTArray<uint8_t> printContent;
      rv = aRequest->GetPrintData(printContent);
      NS_ENSURE_SUCCESS(rv, rv);
      // Check before copying, so print data that won't be analyzed isn't
      // copied.
      if (printContent.Length() > MaxMemoryBlobBytes()) {
        return ReportTooLarge(userActionId, printContent.Length());
      }
      RefPtr<dom::BlobImpl> content;
      if (!printContent.IsEmpty()) {
        // MemoryBlobImpl takes ownership of a malloc'd buffer.
        void* buffer = malloc(printContent.Length());
        if (!buffer) {
          return NS_ERROR_OUT_OF_MEMORY;
        }
        memcpy(buffer, printContent.Elements(), printContent.Length());
        content =
            new dom::MemoryBlobImpl(buffer, printContent.Length(), u""_ns);
      }
      return InvokeRunner(request, content, rules, userActionId,
                          aAutoAcknowledge);
    }
    default:
      // No content to extract for other analysis types.
      return InvokeRunner(request, nullptr, rules, userActionId,
                          aAutoAcknowledge);
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
  AssertIsOnMainThread();
  // Once the WASM is running there's no way to cancel it, but that's OK because
  // it should run quickly. What can take a while is streaming a request's data
  // to the module, so the runner stops that. Requests that haven't reached the
  // runner yet are caught by the WasUserActionCanceled() check before calling
  // it.
  MOZ_LOG(
      gContentAnalysisLog, LogLevel::Info,
      ("WASM DLP user action %s cancelled", nsCString(aUserActionId).get()));
  nsCOMPtr<nsIContentAnalysisWasmRunner> runner =
      do_GetService(WASM_RUNNER_CONTRACTID);
  if (runner) {
    MOZ_ALWAYS_SUCCEEDS(runner->Cancel(aUserActionId));
  }
}

void WasmModuleBackend::HandleWasmResponse(
    JSContext* aCx, JS::Handle<JS::Value> aValue,
    const nsACString& aUserActionId, bool aAutoAcknowledge,
    const nsTArray<RefPtr<nsIContentAnalysisRule>>& aRules) {
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

  // The protobuf the module answers with carries only the winning rule's name,
  // so recover that rule's admin-authored message from the rules we handed it.
  nsString ruleName;
  if (NS_SUCCEEDED(response->GetRuleName(ruleName)) && !ruleName.IsEmpty()) {
    for (const auto& rule : aRules) {
      nsString name;
      if (NS_SUCCEEDED(rule->GetName(name)) && name.Equals(ruleName)) {
        nsString message;
        if (NS_SUCCEEDED(rule->GetMessage(message))) {
          response->SetRuleMessage(message);
        }
        break;
      }
    }
  }

  // The module produced a real verdict, so it's genuinely connected.
  mConnectedToAgent = true;
  owner->HandleResponseFromAgent(response, aAutoAcknowledge);
}

nsresult WasmModuleBackend::InvokeRunner(
    dom::BlobImpl* aRequest, dom::BlobImpl* aContent,
    const nsTArray<RefPtr<nsIContentAnalysisRule>>& aRules,
    const nsACString& aUserActionId, bool aAutoAcknowledge) {
  AssertIsOnMainThread();
  RefPtr<ContentAnalysis> owner =
      ContentAnalysis::GetContentAnalysisFromService();
  if (owner && owner->WasUserActionCanceled(aUserActionId)) {
    // The user action was canceled (e.g. while its file's metadata was being
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

  nsIGlobalObject* global = xpc::NativeGlobal(xpc::PrivilegedJunkScope());
  RefPtr<dom::Blob> request = dom::Blob::Create(global, aRequest);
  if (NS_WARN_IF(!request)) {
    return NS_ERROR_FAILURE;
  }
  RefPtr<dom::Blob> content;
  if (aContent) {
    // The blob's size is stored, so this doesn't touch a file.
    ErrorResult error;
    uint64_t size = aContent->GetSize(error);
    if (NS_WARN_IF(error.Failed())) {
      return error.StealNSResult();
    }
    if (size > MaxBytes()) {
      return ReportTooLarge(aUserActionId, size);
    }
    content = dom::Blob::Create(global, aContent);
    if (NS_WARN_IF(!content)) {
      return NS_ERROR_FAILURE;
    }
  }

  RefPtr<dom::Promise> promise;
  nsresult rv = runner->Analyze(aUserActionId, request, content, aRules,
                                getter_AddRefs(promise));
  if (NS_FAILED(rv) || !promise) {
    mConnectedToAgent = false;
    return NS_FAILED(rv) ? rv : NS_ERROR_FAILURE;
  }

  promise->AddCallbacksWithCycleCollectedArgs(
      [self = RefPtr{this}, userActionId = nsCString(aUserActionId),
       aAutoAcknowledge,
       rules = CopyableTArray<RefPtr<nsIContentAnalysisRule>>(aRules)](
          JSContext* aCx, JS::Handle<JS::Value> aValue, ErrorResult&) {
        self->HandleWasmResponse(aCx, aValue, userActionId, aAutoAcknowledge,
                                 rules);
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

nsresult WasmModuleBackend::ReportTooLarge(const nsACString& aUserActionId,
                                           uint64_t aSize) {
  AssertIsOnMainThread();
  MOZ_LOG(gContentAnalysisLog, LogLevel::Warning,
          ("%" PRIu64 " bytes are too large for the DLP wasm module", aSize));
  return NS_DispatchToMainThread(NS_NewRunnableFunction(
      __func__,
      [self = RefPtr{this}, userActionId = nsCString(aUserActionId)]() mutable {
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
        owner->CancelWithError(std::move(userActionId), NS_ERROR_FILE_TOO_BIG);
      }));
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
    if (version.Length() == 0) {
      version = u"(none)";
    }
  }
  auto info = MakeRefPtr<ContentAnalysisDiagnosticInfo>(
      mConnectedToAgent, std::move(version),
      /* aFailedSignatureVerification */ false, mRequestCount,
      /* aIsBuiltInAgent */ true);
  return DiagnosticInfoPromise::CreateAndResolve(info, __func__);
}

void WasmModuleBackend::Shutdown() {
  AssertIsOnMainThread();
  // Drop any runner promise that resolves after this point
  mInert = true;
}

#undef WASM_RUNNER_CONTRACTID

}  // namespace mozilla::contentanalysis
