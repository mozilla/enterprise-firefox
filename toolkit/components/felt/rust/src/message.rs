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
    AccessToken((String, i64)),
    /// The console-supplied primarySecret (64-char hex string), shipped
    /// from the Felt UI process to the spawned browsing Firefox.
    /// Storage encryption uses it as the password to unlock the
    /// `lockstore::kek::password:sqlite` Password KEK that wraps every
    /// per-DB DEK. Must arrive BEFORE the storage layer initializes
    /// (i.e. before `profile-do-change`); sent unconditionally on the
    /// first IPC handshake, ahead of `AccessToken` / `Ready`.
    PrimarySecret(String),
    RefreshTokens,
    FeltReady,
    OpenURL((String, i32, Option<FocusHint>)),
    RestartForced,
    Restarting,
    LogoutShutdown(Option<String>),
    Exiting,
    UpdateReady,
    Shutdown,
}

#[derive(Debug, Serialize, Deserialize)]
pub enum FocusHint {
    StartupToken(String),
    Timestamp(u32),
}

pub const FELT_IPC_VERSION: u32 = 12;
