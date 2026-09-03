---
title: "Increase laptop battery life with a charging threshold"
description: "A practical guide to using TLP and a charging threshold to reduce battery wear on Linux laptops."
date: 2026-09-04
tags: [linux, battery, tlp]
---

Laptop batteries wear out over time. Keeping one at 100% for long periods can add unnecessary stress.

If you mostly use your laptop at a desk, a charging threshold is a simple way to reduce that wear.

## What is a charging threshold?

A charging threshold controls when charging starts and stops:

```text
Start charging: 40%
Stop charging: 80%
```

The laptop charges to 80%, then starts again when the battery falls below 40%. Charge to 100% before travelling when you need the extra runtime.

## Configure a threshold with TLP

[TLP](https://linrunner.de/tlp/) can manage power settings on Linux. On Debian and Ubuntu-based distributions:

```bash
sudo apt install tlp
sudo systemctl enable --now tlp
```

Check the battery and TLP status:

```bash
sudo tlp-stat -s
sudo tlp-stat -b
```

If thresholds are supported, edit `/etc/tlp.conf`:

```text
START_CHARGE_THRESH_BAT0=40
STOP_CHARGE_THRESH_BAT0=80
```

Apply and verify the change:

```bash
sudo tlp start
sudo tlp-stat -b
```

## Check hardware support

Not every laptop supports charging thresholds. Support depends on the model, firmware, and Linux kernel. Run `sudo tlp-stat -b` to check.

## The short version

For a laptop that stays plugged in, start with 40–80%:

```text
Normal desk use:       40–80%
Before travelling:    charge to 100%
Back at the desk:      40–80%
```

Use 100% when you need maximum runtime. A threshold is an optional optimization, not a rule.
