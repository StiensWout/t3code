# Desktop Notifications

The T3 Code desktop app can send native system notifications while the app is in the background and
an agent needs your attention or finishes work.

Open **Settings** → **General** → **Desktop notifications**, then turn on **Notify me while T3 Code
is in the background**. Use **Send test** to confirm that notifications are allowed by your
operating system.

Choose which events can notify you:

- **Approval needed** when an agent is blocked on an approval
- **Waiting for input** when an agent asks a question or needs more direction
- **Agent finished** when a turn completes
- **Agent failed** when a provider or turn ends with an error

Starting and routine working updates do not create notifications. T3 Code suppresses all
notifications while the desktop window is focused. Opening a notification focuses T3 Code and
takes you to the relevant environment and thread.

The title and message text are identical on macOS, Windows, and Linux. The operating system controls
the notification's visual style, placement, timing, and permission settings.

Turn off **Sound** for silent notifications. Turn off **Show names** to replace project and thread
names with a generic message on shared screens.

T3 Code treats the first thread snapshot after launch as current state, not a notification backlog,
so reconnecting does not replay old completions or failures.
