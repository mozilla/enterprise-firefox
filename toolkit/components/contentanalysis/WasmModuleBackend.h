/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef mozilla_contentanalysis_wasmmodulebackend_h
#define mozilla_contentanalysis_wasmmodulebackend_h

#include "ContentAnalysisBackend.h"
#include "MainThreadUtils.h"
#include "js/TypeDecls.h"
#include "nsCOMPtr.h"
#include "nsString.h"
#include "nsTArray.h"

namespace content_analysis::sdk {
class ContentAnalysisRequest;
}  // namespace content_analysis::sdk

namespace mozilla::contentanalysis {

// Backend that produces verdicts from an in-process WebAssembly DLP module.
//
// The module is loaded and executed by SpiderMonkey's wasm engine through a JS
// runner (nsIContentAnalysisWasmRunner).  This backend serializes the request
// to the canonical content_analysis SDK protobuf, hands the bytes to the
// runner, and converts the response back.  The module is fetched by the
// runner from the enterprise console.
class WasmModuleBackend final : public ContentAnalysisBackend {
 public:
  WasmModuleBackend() = default;

  WasmModuleBackend(const WasmModuleBackend&) = delete;
  WasmModuleBackend& operator=(const WasmModuleBackend&) = delete;

  BackendKind Kind() const override { return BackendKind::eWasmModule; }
  nsresult EnsureReady() override;
  nsresult Analyze(nsCOMPtr<nsIContentAnalysisRequest> aRequest,
                   bool aAutoAcknowledge) override;
  nsresult Acknowledge(
      nsCOMPtr<nsIContentAnalysisAcknowledgement> aAcknowledgement,
      const nsACString& aRequestToken) override;
  void CancelUserAction(const nsACString& aUserActionId) override;
  RefPtr<DiagnosticInfoPromise> GetDiagnosticInfo() override;
  void Shutdown() override;

 protected:
  ~WasmModuleBackend() override = default;

 private:
  // Feed the module's verdict back into ContentAnalysis.
  void HandleWasmResponse(JSContext* aCx, JS::Handle<JS::Value> aValue,
                          const nsACString& aUserActionId,
                          bool aAutoAcknowledge);

  // Hand the request/content/rules to the wasm runner and wire its promise
  // back into ContentAnalysis.
  nsresult InvokeRunner(const nsTArray<uint8_t>& aRequestBytes,
                        const nsTArray<uint8_t>& aContentBytes,
                        const nsTArray<RefPtr<nsIContentAnalysisRule>>& aRules,
                        const nsACString& aUserActionId, bool aAutoAcknowledge);

  // Fill aRules with the built-in rule set from the dlp_rules pref, parsing it
  // only when it differs from what is already cached.
  nsresult LoadDlpRules(nsTArray<RefPtr<nsIContentAnalysisRule>>& aRules);

  // Number of Analyze() calls made so far, for GetDiagnosticInfo.
  int64_t mRequestCount MOZ_GUARDED_BY(sMainThreadCapability) = 0;

  // Whether the module most recently ran successfully. Updated whenever an
  // analyze() call to the runner settles.
  bool mConnectedToAgent MOZ_GUARDED_BY(sMainThreadCapability) = false;

  // Set once Shutdown() runs (e.g. when the service swaps this backend out on a
  // live policy change). A runner promise that resolves afterward is dropped so
  // it can't deliver a stale verdict through the still-alive service.
  bool mInert MOZ_GUARDED_BY(sMainThreadCapability) = false;

  // The rules parsed from the dlp_rules pref, and the exact pref string they
  // came from. Comparing the string is what keeps them current across live
  // policy updates: a policy-locked pref does not reliably notify observers, so
  // there is nothing to invalidate the cache from. Only assigned together, and
  // only after a successful parse, so an unparsable rule set is retried on the
  // next request instead of being cached as "no rules".
  nsString mCachedRulesJSON MOZ_GUARDED_BY(sMainThreadCapability);
  nsTArray<RefPtr<nsIContentAnalysisRule>> mCachedRules
      MOZ_GUARDED_BY(sMainThreadCapability);
};

}  // namespace mozilla::contentanalysis

#endif  // mozilla_contentanalysis_wasmmodulebackend_h
