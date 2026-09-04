/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Shared logic for obtaining the enterprise console address.
//!
//! A repack bakes the console address into the AutoConfig file
//! (`firefox.cfg`); on generic builds the file holds
//! [`CONSOLE_ADDRESS_PLACEHOLDER`] instead, and the address is resolved from
//! the [`CONSOLE_ADDRESS_ENV`] environment variable or from the value the
//! console setup dialog persisted in `felt.json`. This crate keeps that
//! resolution identical for every native consumer: the browser (through the
//! felt crate's FFI, used by CreateAppData.cpp) and the standalone crash
//! reporter client. `resolveConsoleAddress` in ConsoleClient.sys.mjs mirrors
//! it in JS.
//!
//! The crate is IO-free: callers hand in file contents and the environment
//! value, so each consumer keeps its own file and environment access (the
//! crash reporter mocks both in its tests).

/// The pref holding the enterprise console address, set by the AutoConfig
/// file.
pub const CONSOLE_ADDRESS_PREF: &str = "enterprise.console.address";

/// Placeholder address in the AutoConfig file of generic (non-repacked)
/// builds. Keep in sync with CONSOLE_ADDRESS_PLACEHOLDER in
/// ConsoleClient.sys.mjs and the placeholder in
/// browser/branding/enterprise/byteshift.py.
pub const CONSOLE_ADDRESS_PLACEHOLDER: &str = "FIREFOX_ENTERPRISE_GENERIC";

/// Environment variable providing the console address on generic builds
/// (used by test harnesses).
pub const CONSOLE_ADDRESS_ENV: &str = "MOZ_ENTERPRISE_CONSOLE_URL";

/// Storage file in the user application data directory where the console
/// setup dialog persists the address on generic builds.
pub const FELT_STORAGE_FILENAME: &str = "felt.json";

/// Key holding the console address in the felt storage file. Keep in sync
/// with FeltStorage.sys.mjs.
pub const FELT_CONSOLE_ADDRESS_KEY: &str = "consoleAddress";

/// Default byte shift applied to AutoConfig files
/// (`general.config.obscure_value`). Keep in sync with OBSCURE_VALUE in
/// browser/branding/enterprise/byteshift.py.
pub const DEFAULT_OBSCURE_VALUE: u8 = 13;

/// Pref-setting functions an AutoConfig file may use to set a string pref.
const PREF_FUNCTIONS: &[&str] = &["lockPref", "defaultPref", "pref"];

/// Extract the console address from the raw contents of an AutoConfig file
/// without evaluating it.
///
/// AutoConfig files are byte shifted by `general.config.obscure_value` and
/// have an intentionally unparseable first line; the shift is undone (trying
/// the default value, then plaintext) and the file scanned for the pref call.
/// On generic builds this yields [`CONSOLE_ADDRESS_PLACEHOLDER`]; pass the
/// result through [`resolve_console_address`].
pub fn console_address_from_autoconfig(contents: &[u8]) -> Option<String> {
    for shift in [DEFAULT_OBSCURE_VALUE, 0] {
        let decoded: Vec<u8> = contents.iter().map(|b| b.wrapping_sub(shift)).collect();
        let Ok(text) = String::from_utf8(decoded) else {
            continue;
        };
        for func in PREF_FUNCTIONS {
            if let Some(value) = find_string_pref_call(&text, func, CONSOLE_ADDRESS_PREF) {
                return Some(value.to_owned());
            }
        }
    }
    None
}

/// Why [`resolve_console_address`] or [`stored_console_address`] could not
/// produce an address. Callers treat every variant as "console setup needed";
/// the variant names the cause for logging.
#[derive(Debug)]
pub enum ResolveError {
    /// felt.json could not be read. `std::io::ErrorKind::NotFound` is the
    /// expected first-run state; other kinds are real problems.
    FeltStorageRead(std::io::Error),
    /// felt.json exists but is not parseable JSON.
    FeltStorageCorrupt,
    /// felt.json holds no (non-empty) console address.
    NoStoredAddress,
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResolveError::FeltStorageRead(e) => {
                write!(f, "could not read the felt storage file: {e}")
            }
            ResolveError::FeltStorageCorrupt => {
                write!(f, "the felt storage file is not parseable JSON")
            }
            ResolveError::NoStoredAddress => {
                write!(f, "the felt storage file holds no console address")
            }
        }
    }
}

impl std::error::Error for ResolveError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ResolveError::FeltStorageRead(e) => Some(e),
            _ => None,
        }
    }
}

impl ResolveError {
    /// The expected setup-needed state: no felt.json yet, or one without an
    /// address. Everything else points at a real problem worth surfacing.
    pub fn is_expected_first_run(&self) -> bool {
        match self {
            ResolveError::FeltStorageRead(e) => e.kind() == std::io::ErrorKind::NotFound,
            ResolveError::FeltStorageCorrupt => false,
            ResolveError::NoStoredAddress => true,
        }
    }
}

/// Resolve a console address that may be [`CONSOLE_ADDRESS_PLACEHOLDER`].
///
/// A real address is returned unchanged. The placeholder resolves to
/// `env_value` (the value of [`CONSOLE_ADDRESS_ENV`]) when non-empty, then to
/// the address stored in felt.json, whose contents `read_felt_json` supplies
/// (called only when needed). The error says why the placeholder could not be
/// resolved; the browser then shows the console setup dialog.
pub fn resolve_console_address(
    address: &str,
    env_value: Option<&str>,
    read_felt_json: impl FnOnce() -> Result<Vec<u8>, std::io::Error>,
) -> Result<String, ResolveError> {
    if address != CONSOLE_ADDRESS_PLACEHOLDER {
        return Ok(address.to_owned());
    }
    if let Some(url) = env_value {
        if !url.is_empty() {
            return Ok(url.to_owned());
        }
    }
    stored_console_address(&read_felt_json().map_err(ResolveError::FeltStorageRead)?)
}

/// Read the console address out of felt.json contents.
pub fn stored_console_address(felt_json: &[u8]) -> Result<String, ResolveError> {
    let json: serde_json::Value =
        serde_json::from_slice(felt_json).map_err(|_| ResolveError::FeltStorageCorrupt)?;
    match json.get(FELT_CONSOLE_ADDRESS_KEY).and_then(|v| v.as_str()) {
        Some(url) if !url.is_empty() => Ok(url.to_owned()),
        _ => Err(ResolveError::NoStoredAddress),
    }
}

/// Outcome of [`remove_stored_console_address`].
pub enum RemoveStoredAddress {
    /// No address was stored (including unparseable contents); nothing to
    /// write back.
    AlreadyAbsent,
    /// The address was removed; the new felt.json contents to write back.
    Removed(String),
    /// The contents are not a JSON object; nothing can be removed.
    Invalid,
}

/// Remove the console address from felt.json contents, keeping other keys.
pub fn remove_stored_console_address(felt_json: &[u8]) -> RemoveStoredAddress {
    let Ok(mut json) = serde_json::from_slice::<serde_json::Value>(felt_json) else {
        return RemoveStoredAddress::AlreadyAbsent;
    };
    let Some(obj) = json.as_object_mut() else {
        return RemoveStoredAddress::Invalid;
    };
    if obj.remove(FELT_CONSOLE_ADDRESS_KEY).is_none() {
        return RemoveStoredAddress::AlreadyAbsent;
    }
    RemoveStoredAddress::Removed(json.to_string())
}

/// Find the string value of a `func("pref", "value");` call, ignoring calls
/// setting other prefs and occurrences of the pref name in other positions.
fn find_string_pref_call<'a>(contents: &'a str, func: &str, pref: &str) -> Option<&'a str> {
    let opener = format!("{func}(");
    let mut search_content = contents;
    loop {
        let (before, s) = search_content.split_once(&format!("\"{pref}\""))?;
        if !before.trim().ends_with(&opener) {
            search_content = s;
            continue;
        }
        let s = s.trim_start_matches(|c: char| c.is_whitespace() || c == ',');
        let (content, _) = s.split_once(");")?;
        return content.trim().strip_prefix('"')?.strip_suffix('"');
    }
}

#[cfg(test)]
mod test {
    use super::*;

    fn encode(plaintext: &str) -> Vec<u8> {
        plaintext
            .bytes()
            .map(|b| b.wrapping_add(DEFAULT_OBSCURE_VALUE))
            .collect()
    }

    const CFG: &str = "// first line is ignored\n\
         lockPref(\"enterprise.console.address\", \"https://console.example.com/foo/\");";

    #[test]
    fn autoconfig_encoded() {
        assert_eq!(
            console_address_from_autoconfig(&encode(CFG)).as_deref(),
            Some("https://console.example.com/foo/")
        );
    }

    #[test]
    fn autoconfig_plaintext() {
        assert_eq!(
            console_address_from_autoconfig(CFG.as_bytes()).as_deref(),
            Some("https://console.example.com/foo/")
        );
    }

    #[test]
    fn autoconfig_default_pref_function() {
        let cfg = r#"defaultPref("enterprise.console.address", "https://d.example.com/");"#;
        assert_eq!(
            console_address_from_autoconfig(cfg.as_bytes()).as_deref(),
            Some("https://d.example.com/")
        );
    }

    #[test]
    fn autoconfig_ignores_other_prefs_and_positions() {
        let cfg = "lockPref(\"other.pref\", \"enterprise.console.address\");\n\
             lockPref(\"enterprise.console.address\", \"https://real.example.com/\");";
        assert_eq!(
            console_address_from_autoconfig(cfg.as_bytes()).as_deref(),
            Some("https://real.example.com/")
        );
    }

    #[test]
    fn autoconfig_missing_pref() {
        assert_eq!(console_address_from_autoconfig(b"// nothing here"), None);
    }

    #[test]
    fn resolve_real_address_passes_through() {
        assert_eq!(
            resolve_console_address("https://console.example.com/", None, || panic!(
                "must not read felt.json"
            ))
            .unwrap(),
            "https://console.example.com/"
        );
    }

    #[test]
    fn resolve_placeholder_from_environment() {
        assert_eq!(
            resolve_console_address(
                CONSOLE_ADDRESS_PLACEHOLDER,
                Some("https://env.example.com/"),
                || panic!("must not read felt.json")
            )
            .unwrap(),
            "https://env.example.com/"
        );
    }

    #[test]
    fn resolve_placeholder_from_felt_storage() {
        assert_eq!(
            resolve_console_address(CONSOLE_ADDRESS_PLACEHOLDER, Some(""), || Ok(
                br#"{"consoleAddress": "https://stored.example.com/"}"#.to_vec()
            ))
            .unwrap(),
            "https://stored.example.com/"
        );
    }

    #[test]
    fn resolve_placeholder_unresolvable_names_the_cause() {
        let no_address = resolve_console_address(CONSOLE_ADDRESS_PLACEHOLDER, None, || {
            Ok(br#"{"deviceId": "abc"}"#.to_vec())
        });
        assert!(matches!(&no_address, Err(ResolveError::NoStoredAddress)));
        assert!(no_address.unwrap_err().is_expected_first_run());

        let missing_file = resolve_console_address(CONSOLE_ADDRESS_PLACEHOLDER, None, || {
            Err(std::io::Error::from(std::io::ErrorKind::NotFound))
        });
        assert!(matches!(
            &missing_file,
            Err(ResolveError::FeltStorageRead(_))
        ));
        assert!(missing_file.unwrap_err().is_expected_first_run());

        let unreadable_file = resolve_console_address(CONSOLE_ADDRESS_PLACEHOLDER, None, || {
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        });
        assert!(!unreadable_file.unwrap_err().is_expected_first_run());

        let corrupt = resolve_console_address(CONSOLE_ADDRESS_PLACEHOLDER, None, || {
            Ok(b"not json".to_vec())
        });
        assert!(matches!(&corrupt, Err(ResolveError::FeltStorageCorrupt)));
        assert!(!corrupt.unwrap_err().is_expected_first_run());
    }

    #[test]
    fn remove_stored_address_keeps_other_keys() {
        let json = br#"{"consoleAddress": "https://x.example.com/", "deviceId": "abc"}"#;
        match remove_stored_console_address(json) {
            RemoveStoredAddress::Removed(new_json) => {
                assert_eq!(new_json, r#"{"deviceId":"abc"}"#);
            }
            _ => panic!("expected Removed"),
        }
    }

    #[test]
    fn remove_stored_address_absent() {
        assert!(matches!(
            remove_stored_console_address(br#"{"deviceId": "abc"}"#),
            RemoveStoredAddress::AlreadyAbsent
        ));
        assert!(matches!(
            remove_stored_console_address(b"not json"),
            RemoveStoredAddress::AlreadyAbsent
        ));
    }

    #[test]
    fn remove_stored_address_invalid() {
        assert!(matches!(
            remove_stored_console_address(b"[1, 2]"),
            RemoveStoredAddress::Invalid
        ));
    }
}
