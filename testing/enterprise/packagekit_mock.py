"""
packagekit_mock.py — self-contained PackageKit dbusmock fixture.

The dbusmock template and the PackageKitMock management class live in the
same file.  When dbusmock loads this file as a template it calls load();
when imported as a regular module only PackageKitMock is used.

Usage:
    mock = PackageKitMock()
    mock.start()

    env = os.environ.copy()
    env["DBUS_SYSTEM_BUS_ADDRESS"] = mock.bus_address
    subprocess.run(["./firefox"], env=env)

    mock.stop()

Changing the updates fixture:
    mock = PackageKitMock(updates=[
        (PK_INFO_SECURITY, "curl;8.0.0;x86_64;updates", "curl"),
    ])
    mock.start()
"""

import os
import subprocess
import time

import dbus
import dbusmock
import dbusmock.mockobject

# ---------------------------------------------------------------------------
# D-Bus / template constants (also useful to callers building custom updates)
# ---------------------------------------------------------------------------

BUS_NAME = "org.freedesktop.PackageKit"
MAIN_OBJ = "/org/freedesktop/PackageKit"
MAIN_IFACE = "org.freedesktop.PackageKit"
SYSTEM_BUS = True

TX_IFACE = "org.freedesktop.PackageKit.Transaction"

REFRESH_CACHE_IFACE = "org.freedesktop.PackageKit.Transaction.RefreshCache"
GET_UPDATES_IFACE = "org.freedesktop.PackageKit.Transaction.GetUpdates"
DOWNLOAD_PACKAGES_IFACE = "org.freedesktop.PackageKit.Transaction.DownloadPackages"
UPDATE_PACKAGES_IFACE = "org.freedesktop.PackageKit.Transaction.UpdatePackages"

PK_INFO_UNKNOWN = dbus.UInt32(1)
PK_INFO_NORMAL = dbus.UInt32(6)
PK_INFO_SECURITY = dbus.UInt32(8)
PK_INFO_BUGFIX = dbus.UInt32(9)
PK_INFO_ENHANCEMENT = dbus.UInt32(10)

PK_EXIT_SUCCESS = dbus.UInt32(1)
PK_EXIT_FAILED = dbus.UInt32(2)

_tx_counter = 0


def raw_message_filter(bus, msg):
    """Intercepts raw D-Bus messages before dbusmock wraps them."""
    member = msg.get_member()
    if member in ("RefreshCache", "GetUpdates", "DownloadPackages", "UpdatePackages"):
        path = msg.get_path()
        if path in dbusmock.mockobject.objects:
            obj = dbusmock.mockobject.objects[path]
            obj._pk_interactive_auth = msg.get_allow_interactive_authorization()

    return dbus.connection.HANDLER_RESULT_NOT_YET_HANDLED


# ---------------------------------------------------------------------------
# dbusmock template — load() and CreateTransaction()
# These are called by dbusmock when this file is used as a template.
# ---------------------------------------------------------------------------


@dbus.service.method(
    "org.freedesktop.PackageKit.TestSuite", in_signature="", out_signature="a(ssasb)"
)
def GetTransactionStates(self):
    """
    Returns a list of structs containing (path, hints, flags) for every
    transaction object currently known to the mock server.
    """
    states = []
    for path, obj in dbusmock.mockobject.objects.items():
        if path.startswith("/org/freedesktop/PackageKit/Transaction/"):
            method = getattr(obj, "_pk_method", "Unknown")
            hints = getattr(obj, "_pk_hints", [])
            auth = getattr(obj, "_pk_interactive_auth", False)

            # Pack using explicit dbus types to match the strict a(ssasb) signature
            states.append((
                dbus.String(path),
                dbus.String(method),
                dbus.Array([dbus.String(h) for h in hints], signature="s"),
                dbus.Boolean(auth),
            ))
    return states


def load(mock, parameters):
    mock._pk_updates = list(parameters.get("Updates", []))
    mock._pk_exit_code = parameters.get("ExitCode", PK_EXIT_SUCCESS)
    mock._pk_delay = float(parameters.get("Delay", 0.0))
    mock._pk_delay_download = float(parameters.get("DelayDownload", 0.0))

    mock.connection.add_message_filter(raw_message_filter)

    mock.AddProperties(
        MAIN_IFACE,
        dbus.Dictionary(
            {
                "VersionMajor": dbus.UInt32(1),
                "VersionMinor": dbus.UInt32(2),
                "VersionMicro": dbus.UInt32(1),
                "BackendName": dbus.String("dbusmock"),
                "BackendDescription": dbus.String(
                    "python-dbusmock PackageKit template"
                ),
                "BackendAuthor": dbus.String(""),
                "Roles": dbus.UInt64(0),
                "Groups": dbus.UInt64(0),
                "Filters": dbus.UInt64(0),
                "MimeTypes": dbus.Array([], signature="s"),
                "Locked": dbus.Boolean(False),
                "NetworkState": dbus.UInt32(4),
                "DistroId": dbus.String("fedora;38;x86_64"),
            },
            signature="sv",
        ),
    )

    mock.AddMethods(
        MAIN_IFACE,
        [
            ("GetTimeSinceAction", "u", "u", "ret = dbus.UInt32(0)"),
            ("CanAuthorize", "s", "u", "ret = dbus.UInt32(1)"),
        ],
    )

    mock.AddMethods(
        "org.freedesktop.PackageKit.Tests",
        [
            ("GetTransactionStates", "", "a(osasb)", GetTransactionStates),
        ],
    )


def emit_percentage(mock_obj, percent_val):
    """Helper to safely notify dbus property changes at the transaction level."""
    mock_obj.EmitSignal(
        "org.freedesktop.DBus.Properties",
        "PropertiesChanged",
        "sa{sv}as",
        [
            "org.freedesktop.PackageKit.Transaction",
            # signature="sv" establishes String keys and Variant values.
            # variant_level=1 wraps the primitive UInt32 tightly inside that Variant box.
            dbus.Dictionary(
                {dbus.String("Percentage"): dbus.UInt32(percent_val, variant_level=1)},
                signature="sv",
            ),
            # Forces the empty list to compile explicitly as an 'as' (Array of Strings)
            dbus.Array([], signature="s"),
        ],
    )


def SetHints(self, hints):
    # Store the hints array on this specific transaction instance
    self._pk_hints = [str(h) for h in hints]


@dbus.service.method(REFRESH_CACHE_IFACE, in_signature="b", out_signature="")
def RefreshCache(self, force):
    self._pk_method = "RefreshCache"
    emit_percentage(self, 0)

    if self._pk_delay > 0:
        # Cache updates don't have a package array; step temporally instead
        time.sleep(self._pk_delay / 2)
        emit_percentage(self, 50)
        time.sleep(self._pk_delay / 2)
        emit_percentage(self, 100)

    repo_ids = ["repo-main", "repo-updates", "repo-security"]

    # Simulate progress from 0 to 100 in steps of 25
    for repo_id in repo_ids:
        for pct in range(0, 101, 25):
            self.EmitSignal(
                TX_IFACE,
                "ItemProgress",
                "suu",
                [dbus.String(repo_id), dbus.UInt32(3), dbus.UInt32(pct)],
            )
        if self._pk_delay > 0:
            time.sleep(self._pk_delay / 4.0)

    self.EmitSignal(TX_IFACE, "Finished", "uu", [self._pk_exit_code, dbus.UInt32(0)])


@dbus.service.method(GET_UPDATES_IFACE, in_signature="t", out_signature="")
def GetUpdates(self, bitfield_filter):
    self._pk_method = "GetUpdates"

    if self._pk_delay > 0:
        time.sleep(self._pk_delay)

    for info, pkg_id, summary in self._pk_updates:
        self.EmitSignal(
            TX_IFACE,
            "Package",
            "uss",
            [dbus.UInt32(info), dbus.String(pkg_id), dbus.String(summary)],
        )
    self.EmitSignal(TX_IFACE, "Finished", "uu", [self._pk_exit_code, dbus.UInt32(0)])


@dbus.service.method(DOWNLOAD_PACKAGES_IFACE, in_signature="bas", out_signature="")
def DownloadPackages(self, store_in_cache, package_ids):
    self._pk_method = "DownloadPackages"
    emit_percentage(self, 0)

    num_packages = len(package_ids)
    if num_packages == 0:
        emit_percentage(self, 100)
        self.EmitSignal(
            TX_IFACE, "Finished", "uu", [self._pk_exit_code, dbus.UInt32(0)]
        )
        return

    ticks = [5, 15, 25, 40, 50, 60, 70, 80, 100]

    for idx, pkg_id in enumerate(package_ids):
        pkg_infos = pkg_id.split(";")
        # Safely handle minimal or malformed mock fallback fields
        pkg_name = pkg_infos[0]
        pkg_ver = pkg_infos[1] if len(pkg_infos) > 1 else "1.0.0"
        pkg_arch = pkg_infos[2] if len(pkg_infos) > 2 else "x86_64"

        # 1. Simulate the download progress sweep over time
        for tick_idx, item_pct in enumerate(ticks):
            # Don't sleep on the first tick (0%) so the state registers instantly
            if self._pk_delay_download > 0 and tick_idx > 0:
                time.sleep(0.5)

            # Calculate fine-grained global transaction percentage
            file_contribution = (item_pct / 100.0) / num_packages
            tx_pct = int(((idx / num_packages) + file_contribution) * 100)
            emit_percentage(self, tx_pct)

        # 2. FIXED: Moved OUT of the inner loop.
        # Emit "Files" signal ONCE per package when its download loop hits 100%
        self.EmitSignal(
            TX_IFACE,
            "Files",
            "sas",
            [
                dbus.String(pkg_id),
                dbus.Array([dbus.String(f"/tmp/{pkg_name}-{pkg_ver}.{pkg_arch}.deb")]),
            ],
        )

    # 3. Finalize transaction sequence states
    emit_percentage(self, 100)
    self.EmitSignal(TX_IFACE, "Finished", "uu", [self._pk_exit_code, dbus.UInt32(0)])


@dbus.service.method(UPDATE_PACKAGES_IFACE, in_signature="tas", out_signature="")
def UpdatePackages(self, transaction_flags, package_ids):
    self._pk_method = "UpdatePackages"

    emit_percentage(self, 0)
    num_packages = len(package_ids)

    for idx, pkg_id in enumerate(package_ids):
        # Make sure that we simulate "long enough" install time so that test harness
        # can catch up the STATE.STAGING transition and check we hit > 90% of the
        # update process
        time.sleep(3)

        for pct in range(0, 101, 25):
            # ItemProgress correctly emits 'suu' (package_id, status_enum, percentage)
            self.EmitSignal(
                TX_IFACE,
                "ItemProgress",
                "suu",
                [dbus.String(pkg_id), dbus.UInt32(3), dbus.UInt32(pct)],
            )

            # Map the mock steps to actual PackageKit PkStatusEnum values
            # 8 = download, 10 = update, 11 = cleanup, 18 = finished
            status_enum = 0
            if pct < 40:
                status_enum = 8
            elif pct < 60:
                status_enum = 10
            elif pct < 80:
                status_enum = 11
            else:
                status_enum = 18

            # StatusChanged emits 'u' (status_enum)
            self.EmitSignal(TX_IFACE, "StatusChanged", "u", [dbus.UInt32(status_enum)])

        # Dynamic percentage updates step-by-step per installation item
        pct = int(((idx + 1) / num_packages) * 100)
        emit_percentage(self, pct)

    self.EmitSignal(TX_IFACE, "Finished", "uu", [self._pk_exit_code, dbus.UInt32(0)])
    emit_percentage(self, 100)


@dbus.service.method(MAIN_IFACE, in_signature="", out_signature="o")
def CreateTransaction(self):
    global _tx_counter
    _tx_counter += 1
    tx_path = f"/org/freedesktop/PackageKit/Transaction/{_tx_counter}_0"

    self.AddObject(tx_path, TX_IFACE, {}, [])
    tx = dbusmock.mockobject.objects[tx_path]

    tx._pk_updates = self._pk_updates
    tx._pk_exit_code = self._pk_exit_code
    tx._pk_delay = self._pk_delay
    tx._pk_delay_download = self._pk_delay_download

    tx.AddMethods(
        TX_IFACE,
        [
            ("SetHints", "as", "", SetHints),
            (
                "Cancel",
                "",
                "",
                "self.EmitSignal('%s', 'Finished', 'uu', [dbus.UInt32(5), dbus.UInt32(0)])"
                % TX_IFACE,
            ),
            ("RefreshCache", "b", "", RefreshCache),
            ("GetUpdates", "t", "", GetUpdates),
            ("DownloadPackages", "bas", "", DownloadPackages),
            ("UpdatePackages", "tas", "", UpdatePackages),
        ],
    )

    return dbus.ObjectPath(tx_path)


dbusmock.mockobject.DBusMockObject.CreateTransaction = CreateTransaction


# ---------------------------------------------------------------------------
# PackageKitMock — manages the private bus and mock server lifetime
# ---------------------------------------------------------------------------


class PackageKitMock:
    """
    Starts a PackageKit dbusmock on a private system bus.

    Parameters
    ----------
    updates : list of (info, package_id, summary) tuples, optional
        The updates to report via Package signals.  Each element is a plain
        Python tuple — no need to wrap values in dbus types, the class
        handles that.  Defaults to DEFAULT_UPDATES.

        Example:
            from packagekit_mock import PackageKitMock, PK_INFO_SECURITY
            mock = PackageKitMock(updates=[
                (PK_INFO_SECURITY, "curl;8.0.0;x86_64;updates", "curl"),
            ])

    exit_code : dbus.UInt32, optional
        The exit code sent in the Finished signal.  Use PK_EXIT_SUCCESS (1,
        default) or PK_EXIT_FAILED (2) to simulate an error.

    delay : float, optional
        Seconds to sleep inside GetUpdates before emitting signals.  Useful
        for testing timeout handling.  Default 0.
    """

    def __init__(self, updates=None, exit_code=None, delay=0.0, delay_download=0.0):
        self._parameters = {
            "Updates": list(updates) if updates is not None else [],
            "ExitCode": exit_code if exit_code is not None else PK_EXIT_SUCCESS,
            "Delay": float(delay),
            "DelayDownload": float(delay_download),
        }
        self._proc = None
        self._bus_pid = None
        self.bus_address = None

    def set_updates(self, updates):
        """
        Replace the updates list before calling start(), or between stop()
        and a subsequent start().  Cannot be called while the mock is running.
        """
        if self._proc is not None:
            raise RuntimeError("Cannot change updates while the mock is running")
        self._parameters["Updates"] = list(updates)

    def start(self):
        """
        Start a private dbus-daemon via dbus-launch, then spawn the mock
        server on it.

        dbus-launch is used rather than dbusmock's internal start_dbus() so
        that the bus address is a real environment variable that child
        processes (e.g. a Firefox build) inherit automatically without any
        extra plumbing.

        Sets DBUS_SYSTEM_BUS_ADDRESS in os.environ for the current process
        and all subprocesses spawned after this call.
        """
        if self._proc is not None:
            raise RuntimeError("Mock is already running; call stop() first")

        # --- 1. Start a private dbus-daemon via dbus-launch ----------------
        # --sh-syntax emits:
        #   DBUS_SESSION_BUS_ADDRESS='unix:path=...'; export DBUS_SESSION_BUS_ADDRESS;
        #   DBUS_SESSION_BUS_PID=12345; export DBUS_SESSION_BUS_PID;
        launch = subprocess.run(
            ["dbus-launch", "--sh-syntax"],
            check=True,
            capture_output=True,
            text=True,
        )

        env_vars = {}
        for line in launch.stdout.splitlines():
            line = line.strip().rstrip(";")
            if "=" in line and not line.startswith("export"):
                key, _, value = line.partition("=")
                env_vars[key.strip()] = value.strip().strip("'")

        self.bus_address = env_vars["DBUS_SESSION_BUS_ADDRESS"]
        self._bus_pid = int(env_vars["DBUS_SESSION_BUS_PID"])

        # Mirror the session bus address to the system bus variable so GDBus
        # and dbus-python both connect to our private daemon when they ask for
        # the "system" bus.
        os.environ["DBUS_SYSTEM_BUS_ADDRESS"] = self.bus_address

        # --- 2. Spawn the mock server on the private bus -------------------
        self._proc, _ = dbusmock.DBusTestCase.spawn_server_template(
            __file__,
            self._parameters,
            stdout=subprocess.PIPE,
            system_bus=True,
        )

    def stop(self):
        """
        Shut down the mock server and the private dbus-daemon cleanly.

        Sends SIGTERM then waits for each process in order (mock first, then
        daemon) so the daemon does not log spurious disconnect errors.
        Clears DBUS_SYSTEM_BUS_ADDRESS from os.environ.
        """
        if self._proc:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait()
            self._proc = None

        if self._bus_pid:
            try:
                os.kill(self._bus_pid, 15)  # SIGTERM
                # Wait for the daemon to exit; it is a direct child of
                # dbus-launch, not of this process, so we poll instead of
                # wait().
                import time

                for _ in range(50):
                    try:
                        os.kill(self._bus_pid, 0)  # check still alive
                        time.sleep(0.1)
                    except ProcessLookupError:
                        break
                else:
                    os.kill(self._bus_pid, 9)  # SIGKILL if still alive
            except ProcessLookupError:
                pass  # already gone
            self._bus_pid = None

        os.environ.pop("DBUS_SYSTEM_BUS_ADDRESS", None)
        self.bus_address = None
