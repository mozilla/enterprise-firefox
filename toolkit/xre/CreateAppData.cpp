/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsXULAppAPI.h"
#include "nsINIParser.h"
#include "nsIFile.h"
#include "nsURLHelper.h"
#include "mozilla/XREAppData.h"

// This include must appear early in the unified cpp file for toolkit/xre to
// make sure OSX APIs make use of the OSX TextRange before mozilla::TextRange is
// declared and made a global symbol by a "using namespace mozilla" declaration.
#ifdef XP_MACOSX
#  include <Carbon/Carbon.h>
#endif

#if defined(MOZ_ENTERPRISE)
#  include "mozilla/toolkit/components/felt/felt.h"
#  include "mozilla/Try.h"
#  include "mozilla/URLPreloader.h"
#  include "nsXREDirProvider.h"
#  include "nsString.h"
#endif

using namespace mozilla;

static void ReadString(nsINIParser& parser, const char* section,
                       const char* key, XREAppData::CharPtr& result) {
  nsCString str;
  nsresult rv = parser.GetString(section, key, str);
  if (NS_SUCCEEDED(rv)) {
    result = str.get();
  }
}

struct ReadFlag {
  const char* section;
  const char* key;
  uint32_t flag;
};

static void ReadFlag(nsINIParser& parser, const char* section, const char* key,
                     uint32_t flag, uint32_t& result) {
  char buf[6];  // large enough to hold "false"
  nsresult rv = parser.GetString(section, key, buf, sizeof(buf));
  if (NS_SUCCEEDED(rv) || rv == NS_ERROR_LOSS_OF_SIGNIFICANT_DATA) {
    if (buf[0] == '1' || buf[0] == 't' || buf[0] == 'T') {
      result |= flag;
    }
    if (buf[0] == '0' || buf[0] == 'f' || buf[0] == 'F') {
      result &= ~flag;
    }
  }
}

nsresult XRE_ParseAppData(nsIFile* aINIFile, XREAppData& aAppData) {
  NS_ENSURE_ARG(aINIFile);

  nsresult rv;

  nsINIParser parser;
  rv = parser.Init(aINIFile);
  if (NS_FAILED(rv)) return rv;

  ReadString(parser, "App", "Vendor", aAppData.vendor);
  ReadString(parser, "App", "Name", aAppData.name);
  ReadString(parser, "App", "RemotingName", aAppData.remotingName);
  ReadString(parser, "App", "Version", aAppData.version);
  ReadString(parser, "App", "BuildID", aAppData.buildID);
  ReadString(parser, "App", "ID", aAppData.ID);
  ReadString(parser, "App", "Copyright", aAppData.copyright);
  ReadString(parser, "App", "Profile", aAppData.profile);
  ReadString(parser, "Gecko", "MinVersion", aAppData.minVersion);
  ReadString(parser, "Gecko", "MaxVersion", aAppData.maxVersion);
  ReadString(parser, "Crash Reporter", "ServerURL", aAppData.crashReporterURL);
  ReadString(parser, "App", "UAName", aAppData.UAName);
  ReadString(parser, "AppUpdate", "URL", aAppData.updateURL);
  ReadFlag(parser, "XRE", "EnableProfileMigrator",
           NS_XRE_ENABLE_PROFILE_MIGRATOR, aAppData.flags);
  ReadFlag(parser, "Crash Reporter", "Enabled", NS_XRE_ENABLE_CRASH_REPORTER,
           aAppData.flags);

  return NS_OK;
}

#if defined(MOZ_ENTERPRISE)
// Path to felt.json, the profile-independent enterprise storage file kept in
// UAppData. It must be computable before the directory service and XPCOM are
// up, which is why nsXREDirProvider's static helper is used.
static nsresult GetFeltStorageFilePath(nsCString& aOutPath) {
  nsCOMPtr<nsIFile> dir;
  nsresult rv = nsXREDirProvider::GetUserAppDataDirectory(getter_AddRefs(dir));
  NS_ENSURE_SUCCESS(rv, rv);
  // The first GetUserAppDataDirectory call hands out the instance that
  // nsXREDirProvider caches and serves as UAppData for the rest of startup,
  // so it must not be mutated: appending without cloning would turn UAppData
  // into .../felt.json for every later consumer.
  nsCOMPtr<nsIFile> file;
  rv = dir->Clone(getter_AddRefs(file));
  NS_ENSURE_SUCCESS(rv, rv);
  rv = file->AppendNative("felt.json"_ns);
  NS_ENSURE_SUCCESS(rv, rv);
  nsAutoString path;
  rv = file->GetPath(path);
  NS_ENSURE_SUCCESS(rv, rv);
  CopyUTF16toUTF8(path, aOutPath);
  return NS_OK;
}

nsresult XRE_ClearStoredEnterpriseConsoleUrl() {
  nsCString path;
  nsresult rv = GetFeltStorageFilePath(path);
  NS_ENSURE_SUCCESS(rv, rv);
  return firefox_felt_clear_stored_console_url(&path) ? NS_OK
                                                      : NS_ERROR_FAILURE;
}

nsresult XRE_ReadEnterpriseConsoleAddress(const XREAppData& aAppData,
                                          nsACString& aConsoleAddress) {
  nsCOMPtr<nsIFile> cfgFile;
  nsresult rv = aAppData.xreDirectory->Clone(getter_AddRefs(cfgFile));
  NS_ENSURE_SUCCESS(rv, rv);
  rv = cfgFile->Append(u"firefox.cfg"_ns);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCString obscured = MOZ_TRY(URLPreloader::ReadFile(cfgFile));

  // Byte shift decoding and light-weight extraction of the pref value happen
  // in the shared enterprise-console crate; full AutoConfig evaluation only
  // happens in XRE_mainRun.
  if (!firefox_felt_console_address_from_autoconfig(&obscured,
                                                    &aConsoleAddress)) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  return NS_OK;
}

nsresult XRE_ParseEnterpriseServerURL(XREAppData& aAppData,
                                      const char* aServerUrl) {
  nsCString serverUrl(aServerUrl);
  if (serverUrl.IsEmpty()) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  // On a generic (non-repacked) build the address is the placeholder baked in
  // by the branding; the shared enterprise-console crate resolves it from the
  // test override environment variable or the URL persisted by the console
  // setup dialog. If neither exists the caller shows that dialog. A real
  // address passes through unchanged. The path computation is best effort:
  // it is only read when the placeholder has to be resolved from felt.json.
  nsCString feltJsonPath;
  if (NS_FAILED(GetFeltStorageFilePath(feltJsonPath))) {
    NS_WARNING(
        "Could not compute the felt.json path; a stored console address "
        "cannot be found");
  }
  nsCString resolvedUrl;
  if (!firefox_felt_resolve_console_address(&serverUrl, &feltJsonPath,
                                            &resolvedUrl)) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  serverUrl = resolvedUrl;

  if (serverUrl.Last() != '/') {
    serverUrl.Append('/');
  }

  nsCString crashReporterUrl(serverUrl);
  crashReporterUrl.Append("api/browser/crash-reports/submit");
  aAppData.crashReporterURL = crashReporterUrl.get();

  if (is_felt_ui()) {
    nsCString updateUrl(serverUrl);
    nsCString ausUpdateParams(aAppData.updateURL);
    ausUpdateParams.Replace(0, ausUpdateParams.FindChar('%'), "");
    updateUrl.Append("api/browser/updates/");
    updateUrl.Append(ausUpdateParams);
    aAppData.updateURL = updateUrl.get();
  } else {
    aAppData.updateURL = "";
  }

  return NS_OK;
}
#endif
