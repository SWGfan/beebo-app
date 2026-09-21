using System;
using System.Diagnostics;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using Windows.Data.Json;
using Windows.Media;
using Windows.System.Profile;
using Windows.UI;
using Windows.UI.Core;
using Windows.UI.ViewManagement;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Media;

namespace Beebo.Xbox
{
    /// <summary>
    /// The whole app: one full-screen WebView2 showing the shared Beebo TV web app (apps/smarttv/app, staged
    /// into WebCode\ by `npm run build`). This class only does what a web page cannot:
    ///   - serve the packaged web files (virtual host name),
    ///   - hand the system Back request (controller B) and the media-remote buttons to the page,
    ///   - tell the console that a video is playing (so it does not dim the screen),
    ///   - keep the web view on our own pages only.
    /// The page half of this conversation is apps/smarttv/app/js/platform/xbox.js (message names are listed there).
    /// Modelled on Microsoft's Xbox media sample (github.com/microsoft/Media-App-Samples-for-XBOX, MIT).
    /// </summary>
    public sealed partial class MainPage : Page
    {
        // A name no real site can have (RFC 6761 reserves .example). It is served from the package, not the network.
        // http (not https) on purpose: the page must be able to talk to plain-http servers on the home network
        // (http://192.168.x.x:47811), and a page served over https would have those requests blocked as mixed content.
        // Microsoft Learn: documents can use HTTP or HTTPS URLs at the mapped host name.
        private const string VirtualHost = "appassets.beebo.example";
        private const string StartUrl = "http://" + VirtualHost + "/index.html";
        // Diagnostic only, normally empty. "?hls=js" forces the hls.js player, "?hls=native" forces the web view's own
        // (see docs/XBOX.md, "HLS on Xbox"). Change it, rebuild, run.
        private const string StartQuery = "";
        private const string WebFolder = "WebCode";

        private WebView2 webView;
        private readonly SystemMediaTransportControls smtc;
        private bool isNavigatedToPage = false;

        // The page's answer to "can you use a Back press right now?". False = let the system take it (Xbox Home).
        private bool pageCanGoBack = false;
        private int renderFailures = 0;

        public MainPage()
        {
            this.InitializeComponent();

            // Draw edge to edge. The web app keeps its own 5% TV-safe margins (theme.css), so the automatic
            // TV-safe border would only double them. Microsoft Learn: "Designing for Xbox and TV", TV-safe area.
            ApplicationView.GetForCurrentView().SetDesiredBoundsMode(ApplicationViewBoundsMode.UseCoreWindow);

            // System media controls: tells the console a video is playing (no screen dimming), and delivers the
            // buttons of a physical media remote.
            smtc = SystemMediaTransportControls.GetForCurrentView();
            smtc.IsEnabled = true;
            smtc.IsPlayEnabled = true;
            smtc.IsPauseEnabled = true;
            smtc.IsStopEnabled = true;
            smtc.IsNextEnabled = true;
            smtc.IsPreviousEnabled = true;
            smtc.IsFastForwardEnabled = true;
            smtc.IsRewindEnabled = true;
            smtc.ButtonPressed += OnSmtcButtonPressed;

            // Controller B / remote Back arrives here when the page did not take the key itself.
            SystemNavigationManager.GetForCurrentView().BackRequested += OnBackRequested;

            InitializeWebView();
        }

        private async void InitializeWebView()
        {
            webView = new WebView2();
            webView.Background = new SolidColorBrush(Color.FromArgb(255, 11, 13, 18));

            await webView.EnsureCoreWebView2Async();
            CoreWebView2 core = webView.CoreWebView2;
            if (core == null)
            {
                ShowMessage("Beebo could not start its web view on this console.");
                return;
            }

            // Must happen after EnsureCoreWebView2Async: before that the control cannot take focus.
            this.Content = webView;
            webView.Focus(FocusState.Programmatic);

            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDevToolsEnabled = false; // remote debugging (Debug builds) does not need this
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            // SmartScreen (URL reputation) stays ON: the app talks to servers the owner typed, so it is not
            // only "our own pages" in the sense that would make turning it off safe.

            // Serve the packaged web app. Deny other sites any access to these files.
            core.SetVirtualHostNameToFolderMapping(VirtualHost, WebFolder, CoreWebView2HostResourceAccessKind.Deny);

            // Tell the page it is running on an Xbox (before any page script runs).
            string form = AnalyticsInfo.DeviceForm ?? "";
            string version = Windows.ApplicationModel.Package.Current.Id.Version.Major + "." +
                             Windows.ApplicationModel.Package.Current.Id.Version.Minor + "." +
                             Windows.ApplicationModel.Package.Current.Id.Version.Build;
            string marker = "window.__beeboXbox = { deviceForm: " + JsonValue.CreateStringValue(form).Stringify() +
                            ", host: \"uwp-webview2\", version: " + JsonValue.CreateStringValue(version).Stringify() + " };";
            await core.AddScriptToExecuteOnDocumentCreatedAsync(marker);

            webView.WebMessageReceived += OnWebMessageReceived;
            webView.NavigationStarting += OnNavigationStarting;
            webView.NavigationCompleted += OnNavigationCompleted;
            core.NewWindowRequested += OnNewWindowRequested;
            core.LaunchingExternalUriScheme += OnLaunchingExternalUriScheme;
            core.ProcessFailed += OnProcessFailed;

            webView.Source = new Uri(StartUrl + StartQuery);
        }

        private void ShowMessage(string text)
        {
            this.Content = new TextBlock
            {
                Text = text,
                Foreground = new SolidColorBrush(Colors.White),
                FontSize = 36,
                TextWrapping = TextWrapping.Wrap,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(96)
            };
        }

        // ---- keep the web view on our own pages -----------------------------------------------------------------

        private void OnNavigationStarting(WebView2 sender, CoreWebView2NavigationStartingEventArgs args)
        {
            isNavigatedToPage = false;
            Uri uri;
            bool ours = Uri.TryCreate(args.Uri, UriKind.Absolute, out uri) &&
                        (uri.Host == VirtualHost && uri.Scheme == "http" || args.Uri == "about:blank");
            if (!ours)
            {
                // Store policy 10.2.1: an Xbox app must not become a general web browser.
                args.Cancel = true;
                Debug.WriteLine("Beebo: blocked navigation to " + args.Uri);
            }
        }

        private void OnNavigationCompleted(WebView2 sender, CoreWebView2NavigationCompletedEventArgs args)
        {
            if (args.IsSuccess)
            {
                isNavigatedToPage = true;
                webView.Focus(FocusState.Programmatic);
            }
            else
            {
                Debug.WriteLine("Beebo: page load failed: " + args.WebErrorStatus);
            }
        }

        private void OnNewWindowRequested(CoreWebView2 sender, CoreWebView2NewWindowRequestedEventArgs args)
        {
            args.Handled = true; // no pop-ups
        }

        private void OnLaunchingExternalUriScheme(CoreWebView2 sender, CoreWebView2LaunchingExternalUriSchemeEventArgs args)
        {
            args.Cancel = true; // the page never needs to start another app
        }

        private void OnProcessFailed(CoreWebView2 sender, CoreWebView2ProcessFailedEventArgs args)
        {
            Debug.WriteLine("Beebo: web view process failed: " + args.ProcessFailedKind + " (" + args.Reason + ")");
            bool renderer = args.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited ||
                            args.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive;
            if (renderer && renderFailures < 3)
            {
                renderFailures++;
                var ignored = Dispatcher.RunAsync(CoreDispatcherPriority.Normal, () => webView.Reload());
            }
        }

        // ---- messages from the page (JSON strings; see js/platform/xbox.js) -------------------------------------

        private void OnWebMessageReceived(WebView2 sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            JsonObject json;
            if (!JsonObject.TryParse(args.TryGetWebMessageAsString(), out json)) return;
            if (!json.ContainsKey("type")) return;

            switch (json.GetNamedString("type"))
            {
                case "playback":
                    string state = json.GetNamedString("state", "");
                    smtc.PlaybackStatus = state == "playing" ? MediaPlaybackStatus.Playing
                                        : state == "paused" ? MediaPlaybackStatus.Paused
                                        : MediaPlaybackStatus.Stopped;
                    break;
                case "backstate":
                    pageCanGoBack = json.GetNamedBoolean("canGoBack", false);
                    break;
                case "exit":
                    // Nothing to do: at the top of the app the next B press is left to the system, which goes Home.
                    break;
            }
        }

        // ---- Back (controller B) and the media remote -------------------------------------------------------------

        private void OnBackRequested(object sender, BackRequestedEventArgs e)
        {
            // If the page can use the press (a screen or panel to close), hand it over. Otherwise leave
            // e.Handled false: the system then returns to the Xbox Home screen, which is what B does at the top of an app.
            if (!isNavigatedToPage || !pageCanGoBack) return;
            e.Handled = true;
            var ignored = webView.ExecuteScriptAsync("window.beeboXbox && window.beeboXbox.back();");
        }

        private async void OnSmtcButtonPressed(SystemMediaTransportControls sender, SystemMediaTransportControlsButtonPressedEventArgs args)
        {
            // Can arrive on a background thread: hop to the UI thread before touching the web view.
            await Dispatcher.RunAsync(CoreDispatcherPriority.Normal, () =>
            {
                if (!isNavigatedToPage) return;
                string key = null;
                switch (args.Button)
                {
                    case SystemMediaTransportControlsButton.Play: key = "play"; break;
                    case SystemMediaTransportControlsButton.Pause: key = "pause"; break;
                    case SystemMediaTransportControlsButton.Stop: key = "stop"; break;
                    case SystemMediaTransportControlsButton.Next: key = "next"; break;
                    case SystemMediaTransportControlsButton.Previous: key = "prev"; break;
                    case SystemMediaTransportControlsButton.FastForward: key = "ff"; break;
                    case SystemMediaTransportControlsButton.Rewind: key = "rw"; break;
                }
                if (key != null)
                {
                    var ignored = webView.ExecuteScriptAsync("window.beeboXbox && window.beeboXbox.media(\"" + key + "\");");
                }
            });
        }
    }
}
