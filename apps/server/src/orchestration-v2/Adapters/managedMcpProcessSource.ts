/** Shared by the cwd wrapper and Pi's extension, both run outside the server bundle. */
export const MANAGED_MCP_PROCESS_SOURCE = String.raw`
function escapeManagedMcpWindowsArg(arg) {
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  escaped = '"' + escaped + '"';
  return escaped.replace(/([()\][%!^"\x60<>&|;, *?])/g, "^$1");
}

function managedMcpSpawnOptions(command, args) {
  const windows = process.platform === "win32";
  return {
    command: windows ? escapeManagedMcpWindowsArg(command) : command,
    args: windows ? args.map(escapeManagedMcpWindowsArg) : args,
    options: { shell: windows, detached: !windows, windowsHide: true },
  };
}

function terminateManagedMcpChild(child, signal) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => { child.kill(signal); });
    return;
  }
  try { process.kill(-child.pid, signal); } catch { /* The owned process group already exited. */ }
}
`;
