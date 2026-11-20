# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

One responsive web UI, packaged as an Android app with Capacitor and also served locally by Bun on a PC. The phone comes first (it's where the watch, the runs and the coach are used day to day); the PC is the same app on a big screen, plus MCP for agents. The two pair and stay in step, end to end encrypted.

## Users

The owner, a runner with a Suunto Run 2 who also lifts, and later a few friends who install the APK themselves. The friends should get through setup with the app's own guidance: creating a Strava API application and adding an AI key, with no command line and no protocol docs. Each install serves one person; there are no accounts.

## Product Purpose

A training coach that works from the user's own data. Workouts come in by themselves from Strava and/or the watch (Suunto over Bluetooth today; watch-agnostic by intent) and stay on the user's own disk. On top of them: how you are today (readiness, a morning check, your body's muscles, sleep and vitals), a plan an LLM coach builds around your week and adjusts as you train (changes wait for your OK and can be undone), strength sessions logged set by set, routes and guided workouts sent to the watch, and how training adds up over time. Four tabs: Today, Coach, Activities, Progress; Body and Settings sit behind them.

The app must stay focused, not overblown: every feature connects to what the user has (Strava, the watch, a plan). Trust comes first: data visibly arrives (the sync board says when each source last came in and turns amber when one fails), and the coach never contradicts itself (one zone model, one weekly target).

Success: after a run the phone already has it, Today leads with how it went, and the plan for the coming days reflects it.

## Positioning

A coach that reads the watch directly over Bluetooth (the same protocol the Suunto app uses, no Suunto account or cloud) and the complete Strava history, plans with your own AI key, and keeps everything in a local folder that agents can also read over MCP.

## Operating Context

- Android phone, often one-handed and outdoors, often right after a workout and tired: Today, the morning check, a strength session set by set, recording a run. Syncs happen on open, on return and hourly; pull down on Today or tap the sync board to sync now. Phone Bluetooth is shared with the watch, so the Suunto app must not hold the link.
- PC at a desk: the same app on a big screen, longer planning conversations with the coach, MCP config for Claude Desktop / Claude Code / Cursor.
- Phone and PC pair with a QR code or a 10-character code and keep plan, lifts, check-ins and coach notes in step over the home network, end to end encrypted.
- Data sources: watch files over BLE, Strava API (watch → Suunto app → Strava), Health Connect, intervals.icu and files (the Suunto cloud export went in 2.56; what it brought in is still read).

## Capabilities and Constraints

- Watch: list folders, download files, incremental backup. Read-only toward the watch. The watch keeps one bond: pairing this app evicts the phone app's bond.
- Strava: OAuth with the user's own API app; rate limits (about 100 requests per 15 minutes) make the first full sync span several runs.
- MCP: stdio and Streamable HTTP; tools for overview, activities, detail, streams, summaries, best efforts, watch files, and sync actions.
- Verified on a physical Suunto Run 2 (Nov 2026); other models follow the same protocol. The UI must still surface protocol errors plainly.
- Undecided: where the Run 2 stores workouts on its filesystem and in what format.

## Brand Commitments

Name: Tartan (formerly FreeSuunto; the track surface, and the app's colour). Watch-agnostic: no watch brand in the name or identity. Device connections (Suunto today) are unofficial and unaffiliated, and never imitate those brands. Voice: plain, direct, honest about what is unverified.

## Evidence on Hand

No screenshots of real watch data, testimonials or usage numbers exist. Do not fabricate them. Demo mode uses a protocol simulator with clearly labelled fake files.

## Product Principles

1. Your data, on your disk: every view should make it obvious where things are stored.
2. Freshness you can see: the sync board always says when each source last came in, and a failure is amber and explained, never only in the log.
3. Say what went wrong and the next step; never fail silently.
4. Setup once, then get out of the way.
5. Honest about the unknown: unverified paths are labelled as such.

## Accessibility & Inclusion

Usable one-handed on a phone outdoors (large touch targets, strong contrast in daylight), keyboard-operable on desktop, respects reduced motion and the system light/dark preference.
