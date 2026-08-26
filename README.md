# Albion Journal

A macOS client for the **Albion Online Data Project** and a website that turns
its prices into profit tables. The official ADP client is Windows-only; this is
a native build for Apple Silicon. Interface in English, Russian and Spanish.

**The website works on its own, in any browser, with no app installed:**
https://vanatoliyv.github.io/albion-craft-profit/

**A fan project. Not affiliated with Sandbox Interactive in any way.
Albion Online is a trademark of SBI.**

---

## What it does

- Reads market prices off your own game client, the same way the official ADP
  client does, and uploads them to the public ADP database.
- Turns those prices into profit tables: crafting, refining, city-to-city
  flipping, Black Market and enchanting, on live Europe-server prices.
- Prices you saw yourself are laid over the public ones wherever they are
  fresher, so a row shows what you actually saw at the auction house rather
  than a crowdsourced number from two hours ago.

No account, no sign-up, no ads, no telemetry. Sharing to the public database is
on by default, the same as the official client, and there is a switch for it in
Settings.

## Read this before installing

The app **passively reads the game's network traffic** on your own machine.
It does not inject into the game client, does not read or write its memory,
does not modify game files, automates nothing, and never draws an overlay
on top of the game.

Asked directly (ticket 1700441, 24 August 2026), Albion Online support
replied with their general policy: third-party tools **may not** modify the
game client, track players outside the player's view, or overlay the game
client. The app does none of those.

But the same reply says this plainly, and you should understand it before
installing:

> All third-party tools are to be used by players at their own risk. We do
> not test each program to see if they are interfering with the client and
> since it is a third-party tool, we can't guarantee it's safe. If our
> cheat protection finds some sort of interference, BattlEye might kick you
> out of the game or apply a ban to your account.

In other words: **SBI has not tested or approved this app.** The risk is
yours. If you are not comfortable with that, do not install it.

## Requirements

- A Mac with Apple Silicon (M1 or newer). There is no Intel build.
- macOS 13 or newer.

## Installing

1. Drag `Albion Journal.app` into `Applications`.
2. The first launch will be blocked: the app is not signed with a paid
   Apple certificate. Open **System Settings → Privacy & Security**, scroll
   down and press **"Open Anyway"**. You only do this once.
3. The app will show a **"Packet access needed"** card. Press "Set up
   access" and enter your Mac password — also once, never again.
4. Quit the app and open it again.

### What the access setup actually does

macOS only hands over network packets with special rights: `/dev/bpf*` are
owned by `root` with mode `600`, and **there is no switch for this** in
System Settings — these are file permissions, not a macOS privacy
permission.

So the app does what Wireshark has done for fifteen years:

- creates an `access_bpf` group;
- adds your user to it;
- installs `/Library/LaunchDaemons/local.albion.journal.ChmodBPF.plist` and
  a script at `/Library/Application Support/Albion Journal/ChmodBPF` that
  hands the devices to that group on every boot.

**The honest downside:** afterwards any program you run can read network
traffic, not just this one. That is the same trade-off Wireshark makes.

### Removing the setup

```sh
sudo launchctl unload /Library/LaunchDaemons/local.albion.journal.ChmodBPF.plist
sudo rm /Library/LaunchDaemons/local.albion.journal.ChmodBPF.plist
sudo rm -rf "/Library/Application Support/Albion Journal"
sudo dseditgroup -o delete access_bpf
```

## Where things live

- App: `/Applications/Albion Journal.app`
- Data: `~/Library/Application Support/Albion Journal/`
  (your own price database, settings, log)

To uninstall: remove the app and that folder, then undo the access setup
with the commands above.

## What is in this repository

- `acp-prices-src/` — the price receiver, MIT licence, no external
  dependencies beyond the Go standard library. It listens locally, takes what
  the packet-reading client sends with `-p`, and serves your own prices to the
  site. Build with `go build -o acp-prices .`
- `index.html`, `items.json`, `weights.json`, `fetch.mjs` — the website and the
  job that refreshes its prices.

## What is inside the app and whose it is

- [albiondata-client](https://github.com/ao-data/albiondata-client) — the
  Albion Online Data Project client, MIT licence. The packet-reading part is a
  build of that project.
- `acp-prices` — the price receiver, part of this project, MIT licence.
- The item name table comes from
  [albibong](https://github.com/imjangkar/albibong), MIT licence.
- The [Pixelify Sans](https://github.com/eifetx/Pixelify-Sans) font,
  SIL OFL 1.1.
- Item icons come from the official Albion Online Render API.
