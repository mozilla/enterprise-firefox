/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Policies: "resource:///modules/policies/Policies.sys.mjs",
});

add_task(async function check_all_policies_are_live() {
  const policies = new Set(Object.keys(lazy.Policies));

  // Set of policies we know cannot be live
  const notLivePolicies = new Set([
    "3rdparty",
    "AllowedDomainsForApps",
    "AppUpdatePin",
    "AppUpdateURL",
    "Authentication",
    "AutoLaunchProtocolsFromOrigins",
    "Bookmarks",
    "BrowserDataBackup",
    "Certificates",
    "Containers",
    "ContentAnalysis",
    "Cookies",
    "DefaultDownloadDirectory",
    "DisableBuiltinPDFViewer",
    "DisabledCiphers",
    "DisableDefaultBrowserAgent",
    "DisableForgetButton",
    "DisableFormHistory",
    "DisableMasterPasswordCreation",
    "DisablePasswordReveal",
    "DisableProfileImport",
    "DisableProfileRefresh",
    "DisableSafeMode",
    "DisableSecurityBypass",
    "DisableSetDesktopBackground",
    "DisableSystemAddonUpdate",
    "DisableThirdPartyModuleBlocking",
    "DisplayBookmarksToolbar",
    "DisplayMenuBar",
    "DNSOverHTTPS",
    "DontCheckDefaultBrowser",
    "DownloadDirectory",
    "EnableTrackingProtection",
    "EncryptedMediaExtensions",
    "EnterpriseStorageEncryption",
    "ExemptDomainFileTypePairsFromFileTypeDownloadWarnings",
    "Extensions",
    "ExtensionSettings",
    "ExtensionUpdate",
    "FirefoxHome",
    "FirefoxSuggest",
    "GenerativeAI",
    "GoToIntranetSiteForSingleWordEntryInAddressBar",
    "Handlers",
    "HardwareAcceleration",
    "Homepage",
    "HttpAllowlist",
    "HttpsOnlyMode",
    "InstallAddonsPermission",
    "LegacyProfiles",
    "LegacySameSiteCookieBehaviorEnabled",
    "LegacySameSiteCookieBehaviorEnabledForDomainList",
    "LocalFileLinks",
    "LocalNetworkAccess",
    "ManagedBookmarks",
    "ManualAppUpdateOnly",
    "MicrosoftEntraSSO",
    "NetworkPrediction",
    "NewTabPage",
    "NoDefaultBookmarks",
    "OfferToSaveLogins",
    "OfferToSaveLoginsDefault",
    "OverrideFirstRunPage",
    "OverridePostUpdatePage",
    "PasswordManagerExceptions",
    "PDFjs",
    "Permissions",
    "PictureInPicture",
    "PopupBlocking",
    "PostQuantumKeyAgreementEnabled",
    "Preferences",
    "PrimaryPassword",
    "PrintingEnabled",
    "PromptForDownloadLocation",
    "RequestedLocales",
    "SanitizeOnShutdown",
    "SearchBar",
    "SearchEngines",
    "SearchSuggestEnabled",
    "SecurityDevices",
    "ShowHomeButton",
    "SkipTermsOfUse",
    "SSLVersionMax",
    "SSLVersionMin",
    "StartDownloadsInTempDirectory",
    "SupportMenu",
    "TranslateEnabled",
    "UserMessaging",
    "UseSystemPrintDialog",
    "VisualSearchEnabled",
    "WebsiteFilter",
    "WindowsSSO",
  ]);

  const livePolicies = policies.difference(notLivePolicies);

  let policiesAppliable = new Set();

  for (const policyName of policies) {
    const policy = lazy.Policies[policyName];
    const hasOnRemove = typeof policy.onRemove === "function";
    if (hasOnRemove) {
      policiesAppliable.add(policyName);
    }
  }

  const livePoliciesNotAppliable = livePolicies.difference(policiesAppliable)
  if (livePoliciesNotAppliable.size) {
    console.debug(`Live policies that are not appliable because of missing remove functions ${JSON.stringify(livePoliciesNotAppliable)}`);
  }

  Assert.equal(livePoliciesNotAppliable.size, 0, "Not all policies are live. Work better.");

  const liveAndNotLive = policiesAppliable.intersection(notLivePolicies)
  if (liveAndNotLive.size) {
    console.debug(
      `Inconsistent state: live and not live ${JSON.stringify(liveAndNotLive)}`
    );
  }
  Assert.equal(
    liveAndNotLive.size,
    0,
    "There should be no policy both live and not live."
  );
});
