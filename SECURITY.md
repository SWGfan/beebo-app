# Security Policy

Beebo Entertainment welcomes reports of security problems, privacy problems and exposed data
in anything we build or run. If you think you found one, we want to hear about it, and we
will not treat good-faith research as an attack.

## Reporting a vulnerability

**Email: [security@beeboentertainment.com](mailto:security@beeboentertainment.com)**

Please include:

- what is affected (product, version, URL or endpoint),
- the steps to reproduce, or a proof of concept that shows the impact,
- what an attacker gains (data exposed, account access, code execution, ...),
- your name or handle if you would like credit (optional).

Please do **not** open a public GitHub issue for a vulnerability, and do not post details
anywhere until the coordinated-disclosure window below has passed (or we have agreed a
date). If you cannot use email, tell us through <https://www.beeboentertainment.com> that
you have a security report and we will arrange a private channel.

If GitHub's "Report a vulnerability" button (private vulnerability reporting) is shown on
this repository's Security tab, you may use that instead.

## What to expect from us

| Step | Target |
|---|---|
| Acknowledge your report | within **3 business days** |
| First assessment (valid or not, severity) | within 10 business days |
| Fix or mitigation for critical and high issues | as fast as we can, aiming for 30 days |
| Fix for medium and low issues | within the 90-day window, where practical |
| Public disclosure | **90 days** after the report, or earlier once a fix has shipped and we have agreed a date |

We will keep you informed as we go. If we need more than 90 days for a hard fix we will say
why and ask for more time; if you disagree, the 90 days stand unless we agree otherwise. If
a vulnerability is already being actively exploited, we may shorten the window and tell users
sooner. We will credit you in the release notes if you want to be named.

There is currently **no paid bug bounty**. This is a free vulnerability disclosure program;
we are grateful for reports and will give credit.

## Supported versions

Only the newest release of each product receives security fixes.

| Product | Supported |
|---|---|
| Beebo Desktop (Windows installer, and the Linux and macOS builds when published) | latest release on <https://www.beeboentertainment.com> only. The app updates itself. |
| Beebo headless server (Docker image) | latest build only |
| Beebo Android apps (phone app, Android Auto app) | latest release only |
| Beebo cloud services (`login.beebo.tv` and related) | the deployed production version |
| Older desktop or app versions | not supported: please reproduce on the latest release |

## Scope

In scope:

- The Beebo cloud services we operate, including `login.beebo.tv` (licensing, accounts,
  relay, pairing). Their source is not in this repository.
- The website `www.beeboentertainment.com` and the download and update feed on it.
- The Beebo Desktop app and the headless server in this repository (Electron app, embedded
  media server, installer, updater), including the update-signature and licence checks.
- The Beebo Android phone app and Android Auto app in this repository.
- This repository's build and release automation (GitHub Actions workflows), for example a
  way to run code or steal secrets through a pull request or workflow.

Out of scope:

- Other people's Beebo servers or accounts. Test only against systems and accounts you own,
  or that the owner has explicitly agreed you may test.
- Denial of service, volumetric or stress testing, and anything that degrades service for
  other people.
- Social engineering or phishing of our staff or users, physical attacks, and attacks on
  employees' personal accounts or devices.
- Third-party services we depend on (Cloudflare, Google Play, GitHub, OVHcloud, TMDB, DuckDNS,
  email providers). Report those to the vendor.
- Automated scanner output without a demonstrated impact; missing security headers or
  cookie flags with no exploit; self-XSS; clickjacking on pages without sensitive actions;
  software-version banners; email-address enumeration on the public sign-in page unless
  it exposes more than the address; rate-limit findings without a security impact.
- Vulnerabilities that need a rooted or jailbroken device, malware already on the device, or
  the attacker already owning the victim's Beebo server administrator account.
- Known issues that we have already listed in public documents.

## What we ask of you

- Follow this policy and act in good faith.
- Avoid privacy violations, data destruction and service disruption. Do not access, change or
  keep other users' data. If you reach user data, stop, and report what you found.
- Use the minimum access needed to show the problem, and stop as soon as you have shown it.
- Do not run tests that could cost other users money or send messages to real users.
- Do not extort us, and do not disclose before the window above without our agreement.

## Safe harbor

<!-- Adapted from the disclose.io "vdp-with-cvd" core terms (CC0-1.0,
     https://github.com/disclose/dioterms). NOT lawyer-reviewed: counsel must check this for
     Canadian law (including the Criminal Code unauthorized-use-of-computer provisions and
     the Copyright Act anti-circumvention rules) before the policy is relied on. -->

When you conduct security research according to this policy, we consider that research to be:

- Authorized with respect to any applicable anti-hacking laws, and we will not initiate or
  support legal action against you for accidental, good-faith violations of this policy;
- Authorized with respect to any relevant anti-circumvention laws, and we will not bring a
  claim against you for circumvention of technology controls;
- Exempt from the restrictions in our Terms of Service and Acceptable Usage Policy that would
  interfere with conducting security research, and we waive those restrictions on a limited
  basis for that purpose; and
- Lawful, helpful to the overall security of the Internet, and conducted in good faith.

You are expected, as always, to comply with all applicable laws. If legal action is started by
a third party against you and you have complied with this policy, we will take steps to make it
known that your actions were conducted in compliance with this policy.

If at any time you have concerns or are uncertain whether your research is consistent with
this policy, please contact us at the address above before going any further.

This safe harbor applies only to legal claims under the control of Beebo Entertainment. It
does not bind independent third parties (for example Cloudflare, Google or a user whose
data you touched), and it is not legal advice.

## Security practices in this repository

Supply-chain and CI controls (pinned GitHub Actions, least-privilege workflow tokens, secret
scanning, dependency updates, SBOMs) are described in
[docs/SUPPLY-CHAIN-SECURITY.md](docs/SUPPLY-CHAIN-SECURITY.md).
