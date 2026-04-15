/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

use anyhow::{bail, Result};
use crash_helper_common::{
    messages::{self, ChildProcessRendezVousReply, Header, Message},
    AncillaryData, GeckoChildId, IPCConnector, IPCConnectorKey, IPCEvent, IPCListener, IPCQueue,
    Pid,
};
use std::{collections::HashMap, ffi::OsString, process, rc::Rc};

use crate::crash_generation::{CrashGenerator, PlatformData};

#[derive(PartialEq)]
pub enum IPCServerState {
    Running,
    ClientDisconnected,
}

#[derive(PartialEq)]
enum IPCEndpoint {
    /// A connection to the parent process
    Parent,
    /// A connection to the child process
    Child,
    #[allow(dead_code)]
    /// A connection to an external process
    External,
}

struct ProcessId {
    /// The pid of a process.
    pid: Pid,
    /// The Gecko-assigned ID of a process.
    id: GeckoChildId,
}

impl ProcessId {
    fn for_child(pid: Pid, id: GeckoChildId) -> ProcessId {
        ProcessId { pid, id }
    }

    fn for_parent(pid: Pid) -> ProcessId {
        ProcessId { pid, id: 0 }
    }
}

struct IPCConnection {
    /// The platform-specific connector used for this connection
    connector: Rc<IPCConnector>,
    /// The type of process on the other side of this connection
    endpoint: IPCEndpoint,
    /// The identifier of the process at the other end of this connection.
    /// This is `None` for external processes or the Breakpad crash generator
    /// and is set to some value for all other processes that have
    /// successfully rendez-vous'd with the crash helper. In that case the pid
    /// will be the `pid`` of the connected process and the `id` will be the
    /// Gecko-assigned child ID for child proceses or 0 for the main process.
    process: Option<ProcessId>,
    #[allow(dead_code)]
    /// Platform-specific data associated with this connection. Currently used
    /// on macOS/iOS to store the send right to the mach task on the other end
    /// of this connection.
    platform_data: Option<PlatformData>,
}

pub(crate) struct IPCServer {
    /// Platform-specific mechanism to wait for events. This will contain
    /// references to the connectors so needs to be the first element in
    /// the structure so that it's dropped first.
    queue: IPCQueue,
    connections: HashMap<IPCConnectorKey, IPCConnection>,
}

impl IPCServer {
    pub(crate) fn new(
        client_pid: Pid,
        listener: IPCListener,
        connector: IPCConnector,
    ) -> Result<IPCServer> {
        let connector = Rc::new(connector);
        let mut queue = IPCQueue::new(listener)?;
        queue.add_connector(&connector)?;

        let mut connections = HashMap::with_capacity(10);
        connections.insert(
            connector.key(),
            IPCConnection {
                connector,
                endpoint: IPCEndpoint::Parent,
                process: Some(ProcessId::for_parent(client_pid)),
                // TODO: This needs to be populated when we move main process
                // crash generation OOP.
                platform_data: None,
            },
        );

        Ok(IPCServer { queue, connections })
    }

    pub(crate) fn run(&mut self, generator: &mut CrashGenerator) -> Result<IPCServerState> {
        let events = self.queue.wait_for_events()?;

        for event in events.into_iter() {
            match event {
                IPCEvent::Connect(connector) => {
                    self.connections.insert(
                        connector.key(),
                        IPCConnection {
                            connector,
                            endpoint: IPCEndpoint::External,
                            process: None,
                            platform_data: None,
                        },
                    );
                }
                IPCEvent::Message(key, header, payload, ancillary_data) => {
                    if let Err(error) =
                        self.handle_message(key, &header, payload, ancillary_data, generator)
                    {
                        log::error!(
                            "Error {error:#} when handling a message of kind {:?}",
                            header.kind
                        );
                    }
                }
                IPCEvent::Disconnect(key) => {
                    let connection = self
                        .connections
                        .remove(&key)
                        .expect("Disconnection event but no corresponding connection");

                    if let Some(process) = connection.process {
                        generator.move_report_to_id(process.pid, process.id);
                    } else {
                        log::error!("TODO");
                    }

                    if connection.endpoint == IPCEndpoint::Parent {
                        // The main process disconnected, leave
                        return Ok(IPCServerState::ClientDisconnected);
                    }
                }
            }
        }

        Ok(IPCServerState::Running)
    }

    fn handle_message(
        &mut self,
        key: IPCConnectorKey,
        header: &Header,
        data: Vec<u8>,
        ancillary_data: Vec<AncillaryData>,
        generator: &mut CrashGenerator,
    ) -> Result<()> {
        let connection = self
            .connections
            .get(&key)
            .expect("Event received on non-existing connection");
        let connector = &connection.connector;

        match connection.endpoint {
            IPCEndpoint::Parent => match header.kind {
                messages::Kind::SetCrashReportPath => {
                    let message = messages::SetCrashReportPath::decode(data, ancillary_data)?;
                    generator.set_path(message.path);
                }
                messages::Kind::TransferMinidump => {
                    let message = messages::TransferMinidump::decode(data, ancillary_data)?;
                    let crash_report = {
                        if let Some(crash_report) = generator.retrieve_minidump_by_id(message.id) {
                            Some(crash_report)
                        } else if let Some(pid) = self.find_pid(message.id) {
                            generator.retrieve_minidump_by_pid(pid)
                        } else {
                            None
                        }
                    };

                    let reply = crash_report.map_or(
                        messages::TransferMinidumpReply::new(OsString::new(), None),
                        |cr| messages::TransferMinidumpReply::new(cr.path, cr.error),
                    );

                    connector.send_message(reply)?;
                }
                messages::Kind::GenerateMinidump => {
                    todo!("Implement all messages");
                }
                messages::Kind::RegisterChildProcess => {
                    let message = messages::RegisterChildProcess::decode(data, ancillary_data)?;
                    let connector = IPCConnector::from_ancillary(message.ancillary_data)?;
                    connector.send_message(messages::ChildProcessRendezVous::new(
                        process::id() as Pid
                    ))?;
                    let reply = connector.recv_reply::<messages::ChildProcessRendezVousReply>()?;

                    if !reply.dumpable {
                        bail!("Child process {} is not dumpable", reply.child_pid);
                    }

                    let connector = Rc::new(connector);
                    self.queue.add_connector(&connector)?;
                    self.connections.insert(
                        connector.key(),
                        IPCConnection {
                            connector,
                            endpoint: IPCEndpoint::Child,
                            process: Some(ProcessId::for_child(reply.child_pid, reply.id)),
                            platform_data: get_platform_data(reply)?,
                        },
                    );
                }
                #[cfg(any(target_os = "android", target_os = "linux"))]
                messages::Kind::RegisterAuxvInfo => {
                    let message = messages::RegisterAuxvInfo::decode(data, ancillary_data)?;
                    generator.register_auxv_info(message)?;
                }
                #[cfg(any(target_os = "android", target_os = "linux"))]
                messages::Kind::UnregisterAuxvInfo => {
                    let message = messages::UnregisterAuxvInfo::decode(data, ancillary_data)?;
                    generator.unregister_auxv_info(message)?;
                }
                kind => {
                    bail!("Unexpected message {kind:?} from parent process");
                }
            },
            IPCEndpoint::Child => {
                bail!("Unexpected message {:?} from child process", header.kind);
            }
            IPCEndpoint::External => match header.kind {
                #[cfg(target_os = "windows")]
                messages::Kind::WindowsErrorReporting => {
                    let message =
                        messages::WindowsErrorReportingMinidump::decode(data, ancillary_data)?;
                    let res = generator.generate_wer_minidump(message);
                    match res {
                        Ok(_) => {}
                        Err(error) => log::error!(
                            "Could not generate a minidump requested via WER, error: {error:?}"
                        ),
                    }
                    connector.send_message(messages::WindowsErrorReportingMinidumpReply::new())?;
                }
                kind => {
                    bail!("Unexpected message {kind:?} from external process");
                }
            },
        };

        Ok(())
    }

    #[allow(dead_code)]
    fn find_pid(&self, id: GeckoChildId) -> Option<Pid> {
        for connection in self.connections.values() {
            if let Some(process) = connection.process.as_ref() {
                if process.id == id {
                    return Some(process.pid);
                }
            }
        }

        None
    }
}

fn get_platform_data(
    #[allow(unused)] child_rendezvous: ChildProcessRendezVousReply,
) -> Result<Option<PlatformData>> {
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    {
        Ok(None)
    }
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    {
        // HACK: For some reason `.into_iter()` doesn't work here, it yields
        // references instead of owned objects so I have to go through an array
        // to take hold of the send right.
        let mut vector: Vec<AncillaryData> = child_rendezvous.ancillary_data.into();
        let ancillary_data = vector.pop().unwrap();
        if let crash_helper_common::MachPortRight::Send(task_right) = ancillary_data {
            Ok(Some(task_right))
        } else {
            bail!("Wrong right has been provided");
        }
    }
}
