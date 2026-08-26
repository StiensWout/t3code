# Review usage

The Usage page combines Codex and Claude Code activity from your connected environments. It reads
the providers' local session history and shows API-equivalent token cost, processed tokens, cache
savings, provider shares, and model breakdowns. Subscription billing is separate from the raw token
cost shown here.

## Subscription limits

For a saved thread, open the **Usage** section in the thread details panel to see subscription limits
reported by Codex or Claude. The current provider appears first. If the thread previously used
another supported provider, that provider appears underneath it. Open a provider row to see each
limit window and its reset in a dropdown. Show or hide the section under **Settings → Appearance → Provider
usage**.

The limits are hidden on new drafts and for providers or authentication methods that do not report
subscription usage. If a refresh fails, T3 Code keeps the last reported values and marks them with
the time they were last checked.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.
