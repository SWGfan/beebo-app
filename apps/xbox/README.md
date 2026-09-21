# Beebo for Xbox (Xbox One and Xbox Series X|S)

The Beebo app for Xbox. It is a very small Windows app (a "UWP shell", 4 short C# files) that opens one full-screen web
view and shows the **same web app the Samsung and LG TV apps use** (`apps/smarttv`). Nothing is copied: the build step
takes the TV app's files, so a fix made for the Samsung/LG apps arrives on Xbox by rebuilding.

Status: **v0.1. It has not been run on a real Xbox, and the C# shell has never been compiled** (this was written on a PC
with no Visual Studio, and it has not yet been built on GitHub Actions). Everything that can be tested without those
is tested (`npm test`). The honest list of what is and is not verified is in [docs/XBOX.md](../../docs/XBOX.md), section 4.
Expect a small compile fix or two the first time it is built.

```
apps/xbox/
  README.md               this file
  package.json            "npm run build", "npm test", "npm run assets", "npm run identity"
  build.mjs               stages the shared web app + hls.js into shell/WebCode, checks the manifest
  tools/                  manifest checker, placeholder-art maker, test-certificate maker (PowerShell)
  test/                   node --test
  shell/                  the Windows app
    Package.appxmanifest  name, version, capabilities (internetClient + privateNetworkClientServer only)
    Beebo.Xbox.csproj     Visual Studio / MSBuild project (x64 only, Xbox needs x64)
    App.xaml(.cs)         switches off the mouse cursor, sets web-view options
    MainPage.xaml(.cs)    the full-screen WebView2, Back button, media remote, keeps the screen awake
    Assets/               logos (PLACEHOLDERS from the Beebo mascot; the designer replaces them)
    WebCode/              created by "npm run build" (not in git): the web app that gets packaged
```

Shared code (in `apps/smarttv`, used by all three TV builds): `app/js/nav/gamepad.js` (controller mapping, new),
`app/js/platform/xbox.js` and `hls.js` (Xbox-only glue, new), `tools/stage.mjs` (the staging step, now shared).

---

## What you (the owner) must do

You cannot do these by asking a computer; each needs you, your identity or your hardware.

| # | What | Cost | Notes |
|---|---|---|---|
| 1 | **A Microsoft Partner Center developer account** at <https://storedeveloper.microsoft.com> ("Get started") | **$0 registration** per Microsoft's current page (updated 2026-07-17). **Read the price on screen before entering a card**: older news said companies pay $99. | **Decide Individual or Company first: it cannot be changed later.** Microsoft says use *Company* if you distribute in connection with a business (if Beebo Entertainment is run as a business, Company is the right one). Individual: Microsoft account + photo ID + selfie. Company: a D-U-N-S number (fast) or business papers, and a work e-mail on your own domain (for example nick@beebo.tv); manual review 2-5 business days. |
| 2 | **One Xbox console** (any Xbox One, One S, One X, Series S or Series X) you are willing to switch into Developer Mode while you test | $0 | In Developer Mode the console **cannot play retail games or apps**; switching back takes a restart. Best done on a spare or a console nobody is using that day. Uses one of your account's limited "activations". |
| 3 | **A way to build the package**: either (A) GitHub builds it for you, or (B) a Windows PC with **Visual Studio 2022 Community** (free, a large download, and heavy for an old PC) | $0 | (A) needs GitHub Actions to be available. |
| 4 | **A Beebo server the Microsoft reviewers can reach from the internet**, with a demo account, for the whole review | your hosting | Microsoft's rules 10.3.1 and 10.3.2: "provide a working demo account" and "the server must be functional". A house server that is off at night will fail review. Turn on *Settings > Allow TV apps (Samsung/LG) to connect* on it (the Xbox app needs it too). |
| 5 | **A privacy policy web address** | $0 | Required because the app sends a sign-in token and watch progress to your server. The website already has one (`docs/privacy.html`); use its public address. |
| 6 | **Artwork from your designer** (list in "Artwork" below) | designer | Poster, box art, key art and hero **must contain the title "Beebo"**. Placeholders will not pass. |
| 7 | **Screenshots** from the running app (1920x1080 or larger, 4+ recommended) | $0 | Only possible once the app runs. The Device Portal has a *Media capture > Capture Screenshot* button. Use titles you are allowed to show and nothing adult (Store rule 11.1). |
| 8 | **The IARC age-rating questionnaire** | $0 | Done inside the submission (about 10 minutes). Answer honestly. |
| 9 | **A support contact** (e-mail or web page) | $0 | Required by Partner Center for apps on Xbox. |

---

## Part 1: Try it on your PC first (no Xbox, no Visual Studio)

You need **Node.js 24** (<https://nodejs.org>) and, if you like, a USB or Bluetooth game controller.

```
cd apps\smarttv
npm ci
node dev\mock-server.mjs
```

Open Chrome at **<http://localhost:8080/?xbox=1>** (the `?xbox=1` switches on the Xbox controller code). Choose *Type my
server address*, enter `localhost:8080`, sign in with `demo` / `demo` (the mock server's fake account, not a real one). Plug in the controller and press a button once so
Chrome notices it. The mock streams a public sample video.

## Part 2: Build the package

### Option A: GitHub builds it (best for an old PC)

1. On GitHub open the repository > **Actions** > **xbox-build** > **Run workflow**.
2. When it turns green, open the run and download two artifacts:
   * `beebo-xbox-sideload`: a `.msix` for testing on your Xbox (signed with a throw-away test certificate), plus
     `Dependencies` and the `.cer`.
   * `beebo-xbox-store-upload`: the `.msixupload` for the Microsoft Store.

It runs all tests first. It needs no secrets and publishes nothing.

### Option B: on a Windows PC

1. Install **Visual Studio 2022 Community** and tick the workload **Universal Windows Platform development**. Install
   **Node.js 24** and **Git**.
2. Open *PowerShell* and run:
   ```
   cd <your copy of the repository, the JenkinsAPP-github folder>\apps\smarttv
   npm ci
   cd ..\xbox
   npm ci
   npm test
   npm run build
   ```
   `npm run build` prints `[xbox] staged ... files`. If it says `PROBLEM:` fix that first.
3. Open **`apps\xbox\shell\Beebo.Xbox.csproj`** in Visual Studio (File > Open > Project/Solution). Visual Studio downloads the
   three NuGet packages by itself.
4. Toolbar: configuration **Release** (or Debug for testing) and platform **x64**. There is no other choice that works on Xbox.

For a command-line build (what the GitHub workflow does), see `.github/workflows/xbox-build.yml`.

## Part 3: Put your Xbox in Developer Mode

(Microsoft: [Xbox Developer Mode activation](https://learn.microsoft.com/en-us/previous-versions/windows/uwp/xbox-apps/devkit-activation).)

1. On the Xbox, open the **Microsoft Store**, search for **Xbox Dev Mode**, install and open it. It shows a code.
2. On your PC sign in at <https://partner.microsoft.com/dashboard> with your Partner Center account, then go to
   <https://partner.microsoft.com/xboxconfig/devices>. Type the code, click **Agree and activate**.
3. Wait for the progress screen on the Xbox, then in the Xbox Dev Mode app choose **Switch and restart**. The restart is slow.
4. The console now starts in **Dev Home** instead of the normal home screen. **Sign a user in** (you cannot deploy without one).
5. To go back to normal later: Dev Home > Quick Actions > **Leave Dev Mode**.
6. Note the console's **IP address** shown in Dev Home (Remote Access). Your PC and the Xbox must be on the same network.

## Part 4: Install Beebo on the Xbox to test

### Way 1: Visual Studio (the route Microsoft documents)

1. In Dev Home: Remote Access Settings > note the address; keep Dev Home open.
2. In Visual Studio: right-click the project **Beebo.Xbox** > **Properties** > **Debug**. Set **Target device** = *Remote Machine*,
   **Remote machine** = the Xbox's IP address, **Authentication Mode** = *Universal (Unencrypted Protocol)*.
3. Press **F5** (green arrow). If it asks for a **PIN**, read it in the Dev Home app on the console.
4. Beebo opens on the TV. Use **Debug** configuration to be able to look inside the app (see Troubleshooting).
   Debug runs hide the app memory limit: also test a **Release** build before believing it is fine.

### Way 2: upload the package to the Xbox Device Portal (no Visual Studio needed on the PC)

Not verified that the console accepts a self-signed package; if it refuses, use Way 1.

1. Dev Home > Remote Access Settings > tick **Enable Xbox Device Portal** > **Set username and password**.
2. On the PC, open the web address Dev Home shows (it ends in `:11443`). Accept the certificate warning.
3. **Home** tab > add an app: choose the **`.msix`** from `beebo-xbox-sideload` **and every `.appx` file in its `Dependencies`
   folder (the x64 ones)**: they are needed too (the .NET and Visual C++ runtime pieces and Microsoft.UI.Xaml). The exact folder
   layout of the build output has not been seen yet. Install, then start Beebo from the list.

### Then

* On the **Beebo server** (desktop app): Settings > **Allow TV apps (Samsung/LG) to connect** = ON. Without it the app cannot get past its
  first screen (it says it cannot connect).
* In the app choose *Find my home with a code* (no typing; you approve the console from your phone) or *Type my server
  address* (for example `192.168.1.20`).
* Work through the **on-device checklist** in [docs/XBOX.md](../../docs/XBOX.md) section 5, and tell us what failed.

## Part 5: Publish in the Microsoft Store

Do this only after Way 1 works on your console. (Microsoft:
[Create an app submission](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission).)

1. **Account**: finished (see the table above).
2. **Reserve the name**: <https://partner.microsoft.com/dashboard> > **Apps and games** > **New product** > **MSIX or PWA app** >
   type the name (for example *Beebo*) > **Reserve product name**.
3. **Copy the identity into the app.** In the new product open **Product management > Product identity**. Copy the three values
   (Package/Identity/Name, Package/Identity/Publisher, Package/Identity/PublisherDisplayName) and run, in `apps\xbox`:
   ```
   npm run identity -- --identity <Name> --publisher "<Publisher>" --publisher-display "<PublisherDisplayName>"
   ```
   (The Publisher looks like `CN=ABCD1234-...`; keep the quotes.) This edits `shell\Package.appxmanifest`. Commit that change.
4. **Build the Store package**: Option A gives you `beebo-xbox-store-upload`. Option B on a PC:
   ```
   & "C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe" shell\Beebo.Xbox.csproj /restore ^
     /p:Configuration=Release /p:Platform=x64 /p:AppxBundle=Never /p:UapAppxPackageBuildMode=StoreUpload ^
     /p:AppxPackageSigningEnabled=false "/p:AppxPackageDir=$PWD\out\store\"
   ```
   The result is a **`.msixupload`** file (unsigned: the Store signs it).
5. **Start the submission** (product > **Start submission**) and fill in each page:
   * **Pricing and availability**: Free; choose markets; audience Public.
   * **Properties**: category (Entertainment, or the closest); **Privacy policy URL**; **Support contact info** (required for Xbox).
   * **Age ratings**: the IARC questionnaire. Answer honestly.
   * **Packages**: upload the `.msixupload`. Under **Device family availability** tick **Xbox** and **untick** Desktop and the rest
     (the package also runs on a PC, but you are not offering it there).
   * **Store listings**: description; start it with **"Requires your own Beebo home server."** (Microsoft rule 10.2.4); screenshots;
     **Store logos** (poster 2:3, box art 1:1, app tile 300x300); **Xbox images** (branded key art, titled hero, featured square).
   * **Submission options > Notes for certification**: paste, filling in the blanks with a real demo login and server:
     ```
     Beebo is a client for the customer's OWN Beebo home media server; no content is bundled or sold in the app.
     Demo server: <address, for example https://demo.home.beebo.tv:47811>   (online 24/7 during review)
     Demo account: username <...>  password <...>
     First screen: choose "Type my server address", enter the address above, then sign in with the demo account.
     Controller: A select, B back, X play/pause, Y search, LT/RT seek, Menu options.
     Capabilities: internetClient (beebo.tv, the server) and privateNetworkClientServer (a server on the home network).
     ```
   * Click **Submit for certification**. Microsoft gives no fixed review time. If it is rejected the message says which
     policy number; send that to us.
6. After it is published, the Store gives Xbox owners an **Install** button. Updates: raise `version` in `package.json`
   (x.y.z), `npm run build`, build a new `.msixupload`, submit a new submission.

---

## Controls

| Controller | What it does |
|---|---|
| D-pad or left stick | move the focus |
| **A** | select |
| **B** | back (at the top of the app it returns to the Xbox Home screen) |
| **X** | play / pause |
| **Y** | search (from anywhere except the player) |
| **LT / RT** | rewind / fast-forward (hold to scrub faster) |
| **LB / RB** | previous / next episode |
| **Menu** | options while playing (subtitles, audio, quality) |
| **View** | show the progress bar |
| Xbox (Guide) button | belongs to the console; the app cannot use it |
| Media remote | play, pause, stop, next, previous, fast-forward, rewind |

## Artwork

Placeholders come from the existing brand image (`desktop/apps/desktop/electron/pwa/icon-432.png`, the mascot) on the app's
dark background: `npm run assets` remakes them. **They are stand-ins: the mascot has no title text.**

**Inside the app package** (`shell/Assets/`; replace the files, keep names and sizes; the build checks the sizes):

| File | Pixels | Used for |
|---|---|---|
| `Square44x44Logo.targetsize-24_altform-unplated.png` | 24x24 | small icon |
| `Square44x44Logo.scale-200.png` | 88x88 | app list icon |
| `LockScreenLogo.scale-200.png` | 48x48 | badge |
| `StoreLogo.png` | 50x50 | package logo |
| `Square150x150Logo.scale-200.png` | 300x300 | tile |
| `Wide310x150Logo.scale-200.png` | 620x300 | wide tile |
| `SplashScreen.scale-200.png` | 1240x600 | splash screen |

**For the Store page** (uploaded in Partner Center, not in the package; `npm run assets` writes placeholders into `store-assets/`,
which git ignores):

| Picture | Pixels | Required on Xbox | Title on it? |
|---|---|---|---|
| Poster art (2:3) | 720x1080 or 1440x2160 | **yes** | **yes**, in the top two thirds |
| Box art (1:1) | 1080x1080 or 2160x2160 | **yes** | **yes**, in the top two thirds |
| App tile icon (1:1) | 300x300 | recommended | no |
| Super hero art (16:9) | 1920x1080 or 3840x2160 | recommended | no text |
| Xbox branded key art | 584x800 | **yes** | yes + branding bar, top two thirds |
| Xbox titled hero art | 1920x1080 | **yes** | yes, top two thirds |
| Xbox featured promotional square | 1080x1080 | **yes** | **no** |
| Screenshots | 1920x1080 up to 3840x2160 | 1 required, 4+ recommended | real captures |

Microsoft overlays text on the bottom third of these pictures, so keep the title and the key picture in the top two thirds
([source](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/screenshots-and-images)).

## Troubleshooting

* **Blank/black screen at start**: `shell\WebCode` was empty when the package was built (run `npm run build` first; the project
  refuses to build without it), or the web view could not start (the app then says so in text).
* **"Cannot connect to the server"** (though the server is fine): switch on *Allow TV apps (Samsung/LG) to connect* in the Beebo
  desktop settings; check the Xbox and the server are on the same network for a `192.168.x.x` address.
* **B closes the app instead of going back one screen**: report it; see docs/XBOX.md, "Not verified" item 3.
* **Video will not start**: try quality 720p (Menu > Quality). To find out which player the console needs, set `StartQuery` in
  `shell\MainPage.xaml.cs` to `"?hls=js"`, rebuild, try; then `"?hls=native"`. Tell us which one plays.
* **Look inside the app** (Debug build only): on your PC in Microsoft Edge open `edge://inspect`, add the console
  (`https://<console-ip>:11443`) and click **inspect**. One-time certificate steps are in Microsoft's
  [remote debugging page](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/remote-debugging-xbox).
* **The test certificate**: `tools\make-test-cert.ps1` makes `dev-cert\` (git-ignored). Never commit it or send it to anyone.

## Legal

A client for the owner's own server: no content is bundled or hosted. No Microsoft or Xbox logos are used (the words
"Xbox" and "Windows" appear only as technical names). hls.js (Apache-2.0, Copyright Dailymotion) is shipped in the package
with its license file (`vendor/hls.js.LICENSE.txt`). Microsoft's Xbox media sample (MIT) is the model for the shell; no code
was copied wholesale.
