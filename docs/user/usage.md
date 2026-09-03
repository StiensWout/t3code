# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart. Refreshing rescans every connected environment and refetches model pricing on
each of them, so a newly released model that showed $0.00 gets a price without waiting for the daily
pricing update.

The **Limits** tab shows the rolling quota windows your subscription providers report for the
signed-in account, across every connected environment. Each window in use is a bar from the moment
it opened to its reset, filled by how much of the quota is spent. When the provider reports the
window's length and reset time, a thin line marks how far into the window you are, which is also
where even spending would have put the fill, and a small icon says whether you are ahead of, on, or
under that pace. Windows with nothing used yet are left out until they see use. Hover a bar for the exact figures and the reset
time. Codex and Claude Code limits are read from the signed-in subscription whenever the tab opens
or refreshes and update as turns run. Codex accounts with banked reset credits also show how many
are left, and **Use a reset** redeems one after a confirmation. API key sessions and Grok Build do
not report limits.
