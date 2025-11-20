/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub enum FeltMessage {
    VersionProbe(u32),
    VersionValidated(bool),
    ClientChannel(ipc_channel::ipc::IpcSender<FeltMessage>),
    Cookie(String),
    BoolPreference((String, bool)),
    StringPreference((String, String)),
    IntPreference((String, i32)),
    StartupReady,
    Tokens((String, String, i64)),
    ExtensionReady,
    OpenURL(String),
    RestartForced,
    Restarting,
    LogoutShutdown,
}

pub const FELT_IPC_VERSION: u32 = 2;
