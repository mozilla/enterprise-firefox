/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use log::trace;
use nserror::{nsresult, NS_OK};
use nsstring::nsCString;
use thin_vec::ThinVec;
use xpcom::RefPtr;

// ---------------------------------------------------------------------------
// EDR identifiers — adding a variant here forces a compile error in
// detection_methods() on every platform until it is handled.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
pub enum EdrId {
    CrowdStrike,          // CrowdStrike Falcon
    CortexXdr,            // Palo Alto Networks Cortex XDR (formerly Traps)
    SentinelOne,          // SentinelOne Singularity
    MsDefender,           // Microsoft Defender for Endpoint
    CarbonBlack,          // VMware Carbon Black Cloud (Broadcom)
    Trellix,              // Trellix Endpoint Security (formerly McAfee/FireEye)
    Sophos,               // Sophos Intercept X
    CiscoSecureEndpoint,  // Cisco Secure Endpoint (formerly AMP)
    Eset,                 // ESET Endpoint Security
    Cylance,              // BlackBerry Cylance
}

impl EdrId {
    // The complete catalog of known EDR agents. This is the single source of
    // truth; callers (including the device posture payload) enumerate via the
    // getPresentEdrs() XPCOM method rather than hardcoding identifiers.
    pub const ALL: &'static [EdrId] = &[
        EdrId::CrowdStrike,
        EdrId::CortexXdr,
        EdrId::SentinelOne,
        EdrId::MsDefender,
        EdrId::CarbonBlack,
        EdrId::Trellix,
        EdrId::Sophos,
        EdrId::CiscoSecureEndpoint,
        EdrId::Eset,
        EdrId::Cylance,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            EdrId::CrowdStrike => "crowdstrike",
            EdrId::CortexXdr => "cortex-xdr",
            EdrId::SentinelOne => "sentinelone",
            EdrId::MsDefender => "ms-defender",
            EdrId::CarbonBlack => "carbon-black",
            EdrId::Trellix => "trellix",
            EdrId::Sophos => "sophos",
            EdrId::CiscoSecureEndpoint => "cisco-secure-endpoint",
            EdrId::Eset => "eset",
            EdrId::Cylance => "cylance",
        }
    }
}

// ---------------------------------------------------------------------------
// Detection methods — tried in order until one succeeds
// ---------------------------------------------------------------------------

pub enum DetectMethod {
    ProcessPath {
        path_prefixes: &'static [&'static str],
    },
    #[cfg(target_os = "macos")]
    SystemExtension {
        identifier: &'static str,
    },
    #[cfg(target_os = "linux")]
    Service {
        name: &'static str,
    },
    #[cfg(target_os = "linux")]
    DirExists {
        path: &'static str,
    },
    #[cfg(target_os = "windows")]
    WindowsService {
        service_name: &'static str,
    },
    #[cfg(target_os = "windows")]
    ProcessName {
        exe_name: &'static str,
    },
}

// ---------------------------------------------------------------------------
// Per-platform detection methods — exhaustive match on EdrId ensures every
// EDR is covered. Adding a new EdrId variant without handling it here is a
// compile error.
//
// The identifiers below (service names, process names, paths, system
// extension IDs) are taken from the EDAMAME threatmodels
// (https://github.com/edamametechnologies/threatmodels), corroborated with
// vendor documentation. An empty method list means the agent is not
// detectable on that platform from those references.
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn detection_methods(id: EdrId) -> &'static [DetectMethod] {
    match id {
        EdrId::CrowdStrike => &[
            DetectMethod::SystemExtension { identifier: "com.crowdstrike.falcon.Agent" },
        ],
        EdrId::CortexXdr => &[
            DetectMethod::ProcessPath {
                path_prefixes: &["/Library/Application Support/PaloAltoNetworks/Traps/"],
            },
        ],
        EdrId::SentinelOne => &[
            DetectMethod::SystemExtension { identifier: "com.sentinelone.sentineld" },
        ],
        EdrId::MsDefender => &[
            DetectMethod::ProcessPath {
                path_prefixes: &["/Library/Application Support/Microsoft/Defender/"],
            },
        ],
        EdrId::CarbonBlack => &[
            DetectMethod::ProcessPath {
                path_prefixes: &["/Applications/VMware Carbon Black Cloud/"],
            },
        ],
        // Not supported on macOS.
        EdrId::Trellix => &[],
        EdrId::Sophos => &[
            DetectMethod::ProcessPath {
                path_prefixes: &["/Library/Sophos Anti-Virus/"],
            },
        ],
        // Not supported on macOS.
        EdrId::CiscoSecureEndpoint => &[],
        EdrId::Eset => &[
            DetectMethod::ProcessPath {
                path_prefixes: &["/Applications/ESET Endpoint Security.app/"],
            },
        ],
        EdrId::Cylance => &[
            DetectMethod::ProcessPath {
                path_prefixes: &["/Library/Application Support/Cylance/Desktop/"],
            },
        ],
    }
}

#[cfg(target_os = "linux")]
fn detection_methods(id: EdrId) -> &'static [DetectMethod] {
    match id {
        EdrId::CrowdStrike => &[
            DetectMethod::Service { name: "falcon-sensor" },
            DetectMethod::DirExists { path: "/opt/CrowdStrike" },
        ],
        EdrId::CortexXdr => &[
            DetectMethod::Service { name: "traps_pmd" },
            DetectMethod::DirExists { path: "/opt/traps/bin" },
        ],
        EdrId::SentinelOne => &[
            DetectMethod::Service { name: "sentinelone" },
            DetectMethod::DirExists { path: "/opt/sentinelone" },
        ],
        EdrId::MsDefender => &[
            DetectMethod::ProcessPath {
                path_prefixes: &["/opt/microsoft/mdatp/"],
            },
            DetectMethod::DirExists { path: "/opt/microsoft/mdatp" },
        ],
        EdrId::CarbonBlack => &[
            DetectMethod::DirExists { path: "/opt/carbonblack/psc/bin" },
        ],
        // Not supported on Linux.
        EdrId::Trellix => &[],
        EdrId::Sophos => &[
            DetectMethod::Service { name: "sophos-spl" },
            DetectMethod::DirExists { path: "/opt/sophos-spl" },
        ],
        EdrId::CiscoSecureEndpoint => &[
            DetectMethod::DirExists { path: "/opt/cisco/amp" },
        ],
        EdrId::Eset => &[
            DetectMethod::Service { name: "esets" },
        ],
        EdrId::Cylance => &[
            DetectMethod::Service { name: "cylancesvc" },
        ],
    }
}

#[cfg(target_os = "windows")]
fn detection_methods(id: EdrId) -> &'static [DetectMethod] {
    match id {
        EdrId::CrowdStrike => &[
            DetectMethod::WindowsService { service_name: "CSFalconService" },
        ],
        EdrId::CortexXdr => &[
            DetectMethod::WindowsService { service_name: "CyveraService" },
            DetectMethod::ProcessPath {
                path_prefixes: &["C:\\Program Files\\Palo Alto Networks\\Traps\\"],
            },
        ],
        EdrId::SentinelOne => &[
            DetectMethod::WindowsService { service_name: "SentinelAgent" },
        ],
        EdrId::MsDefender => &[
            DetectMethod::WindowsService { service_name: "Sense" },
        ],
        EdrId::CarbonBlack => &[
            DetectMethod::WindowsService { service_name: "CbDefense" },
            DetectMethod::ProcessName { exe_name: "cb.exe" },
        ],
        EdrId::Trellix => &[
            DetectMethod::WindowsService { service_name: "mfemms" },
            DetectMethod::WindowsService { service_name: "mfevtps" },
            DetectMethod::WindowsService { service_name: "mfefire" },
        ],
        EdrId::Sophos => &[
            DetectMethod::WindowsService { service_name: "SEDService" },
            DetectMethod::WindowsService { service_name: "SSPService" },
        ],
        // Not supported on Windows.
        EdrId::CiscoSecureEndpoint => &[],
        EdrId::Eset => &[
            DetectMethod::WindowsService { service_name: "ekrn" },
        ],
        EdrId::Cylance => &[
            DetectMethod::WindowsService { service_name: "CylanceSvc" },
        ],
    }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

fn is_edr_running(id: EdrId) -> bool {
    let app_id = id.as_str();
    for method in detection_methods(id) {
        #[cfg(target_os = "macos")]
        let detected = crate::edr_checker_macos::detect(app_id, method);
        #[cfg(target_os = "linux")]
        let detected = crate::edr_checker_linux::detect(app_id, method);
        #[cfg(target_os = "windows")]
        let detected = crate::edr_checker_win::detect(app_id, method);

        if detected {
            return true;
        }
    }

    trace!("EdrChecker: {} not detected", app_id);
    false
}

// ---------------------------------------------------------------------------
// XPCOM glue
// ---------------------------------------------------------------------------

#[xpcom(implement(nsIEdrChecker), atomic)]
pub struct EdrCheckerXPCOM {}

#[allow(non_snake_case)]
impl EdrCheckerXPCOM {
    pub fn new() -> RefPtr<EdrCheckerXPCOM> {
        EdrCheckerXPCOM::allocate(InitEdrCheckerXPCOM {})
    }

    fn GetPresentEdrs(&self, result: *mut ThinVec<nsCString>) -> nsresult {
        let out = unsafe { &mut *result };
        for &id in EdrId::ALL {
            if is_edr_running(id) {
                out.push(nsCString::from(id.as_str()));
            }
        }
        NS_OK
    }
}

#[no_mangle]
pub extern "C" fn edr_checker_constructor(
    iid: &xpcom::nsIID,
    result: *mut *mut xpcom::reexports::libc::c_void,
) -> nsresult {
    let obj = EdrCheckerXPCOM::new();
    unsafe { obj.QueryInterface(iid, result) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn as_str_values_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for &id in EdrId::ALL {
            assert!(seen.insert(id.as_str()), "duplicate id string: {}", id.as_str());
        }
        assert_eq!(seen.len(), EdrId::ALL.len());
    }
}
