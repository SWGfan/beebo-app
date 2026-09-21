# Beebo on Xbox: research, decisions, and what is (not) verified

Status: v0.1 written 2026-09-21. **Nobody has run this on a real Xbox.** There is no Xbox, no Visual Studio and no
working GitHub Actions on the machine that wrote it. Everything below marked "Source" was read from the linked Microsoft
page on 2026-09-21; everything marked "Not verified" is a claim we could not test. Build and submission steps for a
non-technical owner are in [apps/xbox/README.md](../apps/xbox/README.md).

## 1. The route we chose, and why

**A tiny UWP app (C#, WinUI 2) that shows one full-screen WebView2 (Chromium) with the shared Samsung/LG web app
inside, packaged as MSIX, sold through the Microsoft Store to the Xbox device family.**

* It is the route Microsoft itself documents and demonstrates for media apps on Xbox: the
  [Media App Samples for Xbox](https://github.com/microsoft/Media-App-Samples-for-XBOX) (MIT) are a video player and a music
  player "built primarily in JavaScript and HTML, running in a thin native wrapper containing a full-screen WebView"
  (WebView2 variant). WebView2 for Xbox was announced 2023-11-01 ("Support for modern web features", better performance,
  better remote debugging); STARZ and MakeCode Arcade were the launch examples
  ([announcement](https://blogs.windows.com/msedgedev/2023/11/01/webview2-for-xbox-announcement/)).
* It **reuses `apps/smarttv` unchanged in spirit**: the same HTML/CSS/JS, the same API client, the same D-pad focus
  engine, the same player. `apps/xbox/build.mjs` calls the same staging step as the Tizen/webOS build
  (`apps/smarttv/tools/stage.mjs`); nothing is copied by hand, and a test fails if a second copy of the app appears.
* Cost of the alternatives:
  * *Legacy `Windows.UI.Xaml.Controls.WebView` (EdgeHTML)*: superseded by WebView2; Microsoft's own Xbox docs still say
    its JavaScript debugging works best in Visual Studio 2017. Not chosen.
  * *Fully native XAML + `MediaPlayerElement` + `AdaptiveMediaSource`*: the best-integrated HLS/hardware path, but a
    complete rewrite of the UI (zero reuse). Kept as the fallback **for playback only** if hls.js in WebView2 performs badly.
  * *Hosted web app / PWA*: no D-pad engine and no store presence we control. Not chosen.
* Only x64 apps can run on Xbox, and UWP **games** are no longer accepted in the Xbox store (apps are). Beebo is an app.
  ([FAQ](https://learn.microsoft.com/en-us/windows/uwp/xbox-apps/frequently-asked-questions),
  [system resources](https://learn.microsoft.com/en-us/previous-versions/windows/uwp/xbox-apps/system-resource-allocation))

## 2. Findings (with sources, read 2026-09-21)

### Developer Mode and side-loading

| Finding | Source |
|---|---|
| Any retail Xbox One or Series X\|S can be switched into **Developer Mode** with the free **Xbox Dev Mode** app from the Microsoft Store. In Dev Mode you can test your own apps but **cannot play retail games or run retail apps**; you switch back with Dev Home > Quick Actions > **Leave Dev Mode** (a restart each way). | [Developer Mode activation](https://learn.microsoft.com/en-us/previous-versions/windows/uwp/xbox-apps/devkit-activation) (archived page, updated 2024-10-30) |
| Activation needs a **registered Partner Center app developer account**: the console shows a code, you enter it at partner.microsoft.com/xboxconfig/devices. "You have a limited number of activations associated with your account." | same |
| Deploying needs a user **signed in** on the console (error 0x87e10008 otherwise) and the console reachable on the network. Visual Studio: Debug > Target device **Remote Machine**, address = console IP, Authentication **Universal (Unencrypted Protocol)**, PIN from Dev Home. | [FAQ](https://learn.microsoft.com/en-us/windows/uwp/xbox-apps/frequently-asked-questions), [Microsoft sample README](https://github.com/microsoft/Media-App-Samples-for-XBOX) |
| **Manual side-loading** needs a *signed* app package: Dev Home > Remote Access Settings > enable Xbox Device Portal (choose a user name/password), then the Device Portal **Home** tab uploads the package **and its dependencies**. Device Portal is on port 11443. | [development options](https://learn.microsoft.com/en-us/windows/uwp/apps-for-xbox/development-options), [Device Portal for Xbox](https://learn.microsoft.com/en-us/previous-versions/windows/uwp/xbox-apps/device-portal-xbox), [remote debugging](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/remote-debugging-xbox) |
| A community app (moonlight-xbox) documents the same route and lists the dependency packages it uploads by hand (`Microsoft.UI.Xaml.2.7.appx`, `Microsoft.VCLibs.x64.14.00.appx`) and says a signed certificate is required. | [moonlight-xbox README](https://github.com/TheElixZammuto/moonlight-xbox) (community, not Microsoft) |

### Resources and codecs

| Finding | Source |
|---|---|
| Foreground memory for an **app**: **1 GB** (games 5 GB); background 128 MB. Apps share 2-4 CPU cores and ~45% of the GPU. Limits do not apply under the Visual Studio debugger, so a debug run can hide a memory problem. | [System resources](https://learn.microsoft.com/en-us/previous-versions/windows/uwp/xbox-apps/system-resource-allocation) |
| The `hevcPlayback` capability (4K/HEVC) raises an app to 3.25 GB **but the app can then no longer run beside games**; 4K/HDR10 needs Xbox One S or newer. **We do not declare it**: the Beebo server streams H.264 up to 1080p. | [4K playback on Xbox](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/hevc-xbox) |
| Windows/Xbox decode **H.264 (AVC)** in fMP4, MP4 and MPEG-2 TS, and **AAC-LC / HE-AAC** in MP4 and ADTS (Xbox table). That is exactly the Beebo transcoder's HLS output. | [Supported codecs](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/supported-codecs) (updated 2026-05-12) |
| For video hosted in a web view, keep the **system media transport controls** up to date; among other things this stops the console dimming the screen during playback, and it carries media-remote button presses. | Microsoft sample README and `MainPage.xaml.cs` |

### HLS on Xbox (the main technical unknown)

* Chromium on desktop only got **native HLS** in version 142 (Chrome and Edge, Oct 2025)
  ([report](https://tech-ish.com/2025/12/08/google-chrome-microsoft-edge-chromium-native-hls-playback-desktop/),
  [hls.js discussion 7644](https://github.com/video-dev/hls.js/discussions/7644)). Which Chromium version the WebView2
  runtime on a given console has is **not documented**, so the app decides at run time
  (`apps/smarttv/app/js/platform/hls.js`): if `video.canPlayType('application/vnd.apple.mpegurl')` says yes it uses the
  built-in player, otherwise it loads **hls.js 1.7.3** (Apache-2.0, media-source based; license file ships in the package).
  Tizen and webOS builds never load hls.js.
* hls.js is configured with small buffers (30 s ahead, 20 s behind) because of the 1 GB limit, and without web workers
  (the page's Content-Security-Policy has no `worker-src`).
* Force a side for testing by setting `StartQuery` in `MainPage.xaml.cs` to `?hls=js` or `?hls=native`.

### Input: gamepad, D-pad focus, Back, Guide

* UWP maps keyboard behaviour to the controller: arrows = D-pad and left stick, **Enter/Space = A**, **Escape = B**. When
  neither KeyDown nor KeyUp for B is handled, `SystemNavigationManager.BackRequested` fires. The **Menu** button opens
  context flyouts, **triggers** page up/down (zoom), **bumpers** page left/right, **View** opens/closes navigation panes and
  **Y** is the recommended *search* shortcut. **Mouse mode is on by default** for apps on Xbox One and must be switched off
  with `Application.RequiresPointerMode = WhenRequested` (both XAML and hosted web apps).
  ([Gamepad and remote control interactions](https://learn.microsoft.com/en-us/windows/uwp/ui-input/gamepad-and-remote-interactions))
* Inside a web view the controller arrives as **keyboard events whose `keyCode` is the `Windows.System.VirtualKey` value**:
  GamepadA 195, B 196, X 197, Y 198, right/left shoulder 199/200, left/right trigger 201/202, D-pad up/down/left/right
  203-206, Menu 207, View 208, stick clicks 209/210, left stick 211-214, right stick 215-218; NavigationUp..Cancel 138-143;
  GoBack 166
  ([VirtualKey enum](https://learn.microsoft.com/en-us/uwp/api/windows.system.virtualkey)). Microsoft's own web sample maps
  exactly these codes to focus movement (`directionalnavigation-1.0.0.0.js` from TVHelpers).
* **Our mapping** (one table, `apps/smarttv/app/js/nav/gamepad.js`, unit-tested): **A** select, **B** back, **X**
  play/pause, **Y** search, **D-pad / left stick** move focus, **LT** seek back, **RT** seek forward, **LB/RB**
  previous/next, **Menu** options (subtitle/audio/quality panel), **View** show the on-screen display. The Xbox (Guide)
  button belongs to the console; the app cannot receive or change it (general Xbox behaviour; not found in the pages above).
* Known Microsoft issue: [WebView2Feedback #4366](https://github.com/MicrosoftEdge/WebView2Feedback/issues/4366) (2024-02-09,
  "tracked internally"): the **W3C Gamepad API** did not work in a WebView2 UWP app (reported on Windows 10). So the app
  relies on the key events above and keeps the Gamepad API only as a **fallback poller** that silences itself the moment a real
  gamepad key event is seen (so a press is never delivered twice). The same poller lets you try the controller in desktop
  Chrome with `?xbox=1`.
* WebView2 on Xbox/UWP limitations that matter: DevTools cannot open inside a Store-signed app (use remote debugging from a
  Debug build), no autofill UI, printing/Downloads hub disabled, some CSS cursors unsupported
  ([WebView2 in WinUI 2 (UWP)](https://learn.microsoft.com/en-us/microsoft-edge/webview2/platforms/winui2-uwp)).

### Microsoft Store: policies that touch this app (Store Policies v7.20, 2026-09-14)

Source for every row: [Microsoft Store Policies](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies).

| Policy | What it means for Beebo |
|---|---|
| 10.1.1 accurate metadata, unique title, value clear at first run | The listing must say plainly it plays media from **your own Beebo server**. The first screen (Welcome) already does. |
| 10.2.1 browsers must use Chromium/Gecko; browsing apps **on Xbox** must not let users download or copy files | We use Chromium (WebView2) and the shell **cancels every navigation that is not its own page** and every pop-up. It is not a browser. |
| 10.2.2 no dynamic code that changes the app's behaviour | Only packaged scripts run (`script-src 'self'`); hls.js is shipped inside the package, not fetched. |
| 10.2.4 disclose a dependency on an outside service at the start of the description | Start the description with "Requires your own Beebo home server." |
| **10.3.1 / 10.3.2** provide a working demo account in *Notes for certification*; the server must be functional for testing | **The reviewers must be able to reach a running Beebo server from their own network.** See the owner list. |
| 10.4.1 / 10.4.2 start promptly, stay responsive, handle exceptions | Not testable here; on-device checklist below. |
| 10.5.1 privacy policy URL required if the app collects or transmits personal information | It does (server address, sign-in token, watch progress go to the owner's server). Site policy: [docs/privacy.html](privacy.html). |
| 10.6 capabilities must relate to the function | Only `internetClient` and `privateNetworkClientServer`; a test fails the build if anything else is added. |
| 10.13.4 Xbox products must not request or store Microsoft account credentials or offer general file-system browsing | True: the app stores only its own Beebo token. (10.13.x is otherwise about games.) |
| 11.1 listing text/art must merit ESRB E10+ / PEGI 12 or lower | Keep screenshots and descriptions free of adult titles/posters. |
| 11.2 content must be original, licensed or permitted | No content ships in the app. Screenshots must use content the owner has the right to show. |
| 11.11 age rating via the **IARC questionnaire** at submission; 11.11.3 content that might merit a higher rating than assigned must be opt-in (content filter or existing sign-in) | The Beebo sign-in and the server's parental controls are the opt-in. Answer honestly; see "Age rating" below. |

Certification: "UWP apps created and tested on a retail Xbox One console will go through the same ingestion, review, and
publication process that Windows conducts today, with additional reviews to meet today's Xbox One standards"
([FAQ](https://learn.microsoft.com/en-us/windows/uwp/xbox-apps/frequently-asked-questions)). Microsoft publishes no fixed
review time; do not plan around one.

### Account, cost, age rating

* **Fee: $0 registration** according to the current Microsoft page, for **both** account types, when you start at
  [storedeveloper.microsoft.com](https://storedeveloper.microsoft.com) ("With the new onboarding experience, there are no
  registration fees for either account type"; page updated 2026-07-17)
  ([Open a developer account](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account)).
  Older press said companies still pay $99 ([Windows Central](https://www.windowscentral.com/microsoft/windows-11/microsoft-store-drops-fees-for-individual-developers-apple-still-charges-usd99-per-year));
  the Microsoft page is newer and authoritative, but **read the price on the screen before you enter a card**.
* **Individual vs Company**: Microsoft says use *Company* when distributing "in relation to their business, trade, or
  profession". A Company account **cannot be converted from an Individual one**. Individual = Microsoft account + government
  ID + selfie. Company = D-U-N-S number (fast) or business documents, plus a work e-mail on the company's own domain;
  manual review "typically 2-5 business days".
* The same account is used to activate Developer Mode on the console.
* **Age rating**: a free multiple-choice **IARC** questionnaire inside the submission; ratings then appear per country
  ([Age ratings for MSIX app](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/age-ratings),
  updated 2026-08-21). Not verified what a "shows the owner's own library" app will be rated; expect the questions about
  user-supplied content and unrestricted internet access to raise it. Beebo's product decision is *not* to market a
  kid-safe app, so do not choose child-directed answers.
* **Store pictures** (Xbox): 2:3 poster 720x1080 (**required, with the title**), 1:1 box art 1080x1080 (**required, with the
  title**), 300x300 app tile icon, 16:9 super hero 1920x1080 (no text), Xbox images: branded key art 584x800 (title +
  branding bar), titled hero 1920x1080 (title), featured promotional square 1080x1080 (**no** title); **keep the title and
  key art in the top two thirds**; at least one screenshot (1920x1080 to 3840x2160 for Xbox; four or more recommended)
  ([Screenshots and images](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/screenshots-and-images)).
  Package pictures and the placeholder generator: README "Artwork".

### Building

* The project is a normal UWP project: Visual Studio 2022 with the **Universal Windows Platform development** workload
  ([WebView2 in WinUI 2 getting started](https://learn.microsoft.com/en-us/microsoft-edge/webview2/get-started/winui2)).
  `Microsoft.UI.Xaml` 2.8+ brings the WebView2 SDK with it; versions used (Microsoft.NETCore.UniversalWindowsPlatform 6.2.14,
  Microsoft.UI.Xaml 2.8.7, Microsoft.Web.WebView2 1.0.3179.45) are the ones in Microsoft's sample.
* GitHub's `windows-latest` / `windows-2025` labels moved to **Visual Studio 2026** in June 2026
  ([runner-images #14017](https://github.com/actions/runner-images/issues/14017)); the `windows-2022` image has Visual
  Studio 2022 17.14 with the UWP workload and Windows SDKs 17763/19041/22621/26100
  ([image readme](https://github.com/actions/runner-images/blob/main/images/windows/Windows2022-Readme.md)). The workflow
  pins `windows-2022`.
* Store upload uses `/p:UapAppxPackageBuildMode=StoreUpload` (unsigned; the Store signs). For testing, the workflow signs a
  second package with a throw-away self-signed certificate.

## 3. Design decisions that are easy to get wrong

1. **The page origin is `http://appassets.beebo.example`, not https and not file://.** WebView2 maps a virtual host name to
   the packaged `WebCode` folder and serves it over HTTP or HTTPS
   ([SetVirtualHostNameToFolderMapping](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_3)).
   An https page cannot call a plain-http server such as `http://192.168.1.20:47811` (mixed-content blocking; only loopback is
   exempt), and the app supports exactly those LAN addresses. `.example` is reserved (RFC 6761) so no real site can collide.
2. **CORS**: the page is cross-origin to the home server, so the owner must switch on the same opt-in as for Samsung/LG,
   *Settings > Allow TV apps to connect* (`tvAppCors`, [TV-APP-CORS.md](../desktop/apps/desktop/docs/TV-APP-CORS.md)). The
   server echoes the request's Origin, so `http://appassets.beebo.example` needs no server change. Follow-up (desktop side,
   not done here): the setting's label still says "Samsung/LG".
3. **Sign-in** is unchanged: device-code pairing at beebo.tv then `POST /api/viewer-session`
   ([VIEWER-EXCHANGE.md](../desktop/apps/desktop/docs/VIEWER-EXCHANGE.md)), or a typed address plus username/password. The
   device name the owner sees in the exchange log is "Beebo on Xbox".
4. **Back**: one B press may reach the page twice (key event 196 and the system `BackRequested`). The page drops the second
   one within 300 ms (`shouldDropBack`, unit-tested) and tells the shell whether it can use a Back press; when it cannot (Home,
   nothing open) the shell leaves `BackRequested` unhandled so the system returns to the Xbox Home screen, and the app never
   closes itself.
5. **Nothing is signed or secret in the repo.** The test certificate is created on the machine that builds and is git-ignored.

## 4. Verified vs not verified

### Verified here (automated, runs in `npm test`)

* The gamepad table equals the `VirtualKey` values read from Microsoft Learn on 2026-09-21 and does not change any Tizen,
  webOS or keyboard mapping (the whole TV-app suite passes, 173 tests, and so does the old-Chromium compatibility lint
  that guards the Tizen/webOS engines); the 15 Xbox-folder tests pass.
* The pure logic: button/stick to action mapping with dead zone, edge detection and auto-repeat, silencing when real
  gamepad key events arrive, Back de-duplication, HLS engine choice, hls.js attach/replace/detach and its fatal-error
  handling (all with fakes), the shell/page message contract, media-remote names.
* `npm run build` stages the whole shared app (every module, checked one by one) plus hls.js 1.7.3 into
  `shell/WebCode`; the manifest passes the checks (identity format, version x.y.z.0, exactly the two capabilities, device
  family, every logo present at exactly the right pixel size); the C# shell and the page use the same message names.
* The manifest, project, XAML and workflow files are well-formed (XML/YAML parsed); the PowerShell script parses; every
  action in `xbox-build.yml` is pinned to a commit SHA and the workflow is dispatch-only.

### NOT verified (needs a person with the right machine)

1. **The C# shell has never been compiled**, nor the MSIX built: no Visual Studio/MSBuild here and Actions is blocked. API
   names and package versions follow Microsoft's sample; expect a compile fix or two on the first build.
2. **`xbox-build.yml` has never run.** Likely first-run fixes: the exact `msbuild` properties, where the packages land.
3. **Whether the console delivers controller key events (195-218) to a WebView2 page**, and whether B produces the key
   event, `BackRequested`, or both. The design tolerates all three (de-duplication, fallback poller), but only a console can
   tell. Same for **LT/RT as key events** (they are in Microsoft's table; not observed).
4. **HLS**: which Chromium the console's WebView2 has (native HLS or hls.js path), whether 1080p H.264/AAC HLS plays
   smoothly, seeks, and stays inside **1 GB** (the debugger hides the limit), hls.js on an original Xbox One.
5. **LAN reach from the virtual-host page**: plain-http requests to a LAN server, CORS from the `http://appassets...`
   origin, and whether Chromium's Private Network Access rules block a page served from the virtual host.
6. **System media controls**: that the console really stops dimming the screen during playback and that media-remote
   buttons arrive (Microsoft's sample does this; we copied the approach).
7. **Sideloading a self-signed package via Device Portal** (Microsoft says "signed"; the community says a certificate is
   required; nobody documents whether a self-signed one is accepted). The reliable, Microsoft-documented route is Visual Studio's
   Remote Machine deployment.
8. **Store certification result, age rating outcome, review time**, and whether Xbox reviewers accept a WebView-hosted app
   for a user-supplied server (10.3.2 demo server).
9. **Minimum Xbox OS**: the manifest asks for Windows 10.0.19041 or newer (`MinVersion`); Microsoft's sample asks for
   10.0.26100. Whether the original Xbox One and each Series console meets WebView2's requirement is not documented on the
   pages read.

## 5. On-device test checklist (highest risk first)

1. App starts, shows the Welcome screen, no blank page. (If blank: `WebCode` empty, or the web view failed.)
2. D-pad and left stick move the focus ring; **A** selects. If nothing moves, the controller is not producing key events:
   look at the console debug output and Microsoft issue 4366.
3. **B** goes back one screen; at Home, B returns to the Xbox Home screen (once, not twice).
4. Sign in by pairing; then browse; open a title.
5. Play a movie at 720p and 1080p; **LT/RT** seek; **X** pause; **Menu** opens the options panel; **View** shows the bar;
   watch memory (Device Portal) for a long play.
6. Leave the console idle during playback for longer than the screen-dim time: the picture must not dim.
7. Suspend/resume (Xbox button, then return); switching to a game and back.
8. Repeat with `StartQuery` set to `?hls=js` and `?hls=native` to see which engine your console needs.
9. Debug build only: attach DevTools with `edge://inspect` (steps in the remote-debugging page) if anything fails.

## 6. What the owner must do

See [apps/xbox/README.md](../apps/xbox/README.md), "What you (the owner) must do". Short version: create the Partner Center
account (choose Individual vs Company *before* signing up), put one console in Developer Mode, decide how a review server
and demo account will be reachable from Microsoft, commission the artwork, and run the GitHub Actions build (or use a PC with
Visual Studio 2022).
