/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use serde::{Deserialize, Serialize};

#[allow(non_camel_case_types)]
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct nsICookieWrapper {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub is_session: bool,
    pub expiration: i64,
    pub http_only: bool,
    pub path: String,
    pub same_site: i32,
    pub is_secure: bool,
}

impl nsICookieWrapper {
    pub fn new(
        name: String,
        value: String,
        domain: String,
        is_session: bool,
        expiration: i64,
        http_only: bool,
        path: String,
        same_site: i32,
        is_secure: bool,
    ) -> Self {
        nsICookieWrapper {
            name,
            value,
            domain,
            is_session,
            expiration,
            http_only,
            path,
            same_site,
            is_secure,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub enum FeltMessage {
    VersionProbe(u32),
    VersionValidated(bool),
    ClientChannel(ipc_channel::ipc::IpcSender<FeltMessage>),
    Cookie(nsICookieWrapper),
    BoolPreference((String, bool)),
    StringPreference((String, String)),
    IntPreference((String, i32)),
    StartupReady,
    Tokens((String, String, i64)),
    ExtensionReady,
    OpenURL((String, i32)),
    RestartForced,
    Restarting,
    LogoutShutdown,
}

pub const FELT_IPC_VERSION: u32 = 3;
