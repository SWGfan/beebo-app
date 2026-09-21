using System;
using System.Diagnostics;
using Windows.ApplicationModel;
using Windows.ApplicationModel.Activation;
using Windows.UI.ViewManagement;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Navigation;

namespace Beebo.Xbox
{
    /// <summary>
    /// Application entry point. Everything the console must know BEFORE the first WebView2 is created is set here
    /// (environment variables are read when the web view starts).
    /// </summary>
    sealed partial class App : Application
    {
        public App()
        {
            this.InitializeComponent();
            this.Suspending += OnSuspending;

            // Mouse mode is ON by default for apps on Xbox (a virtual cursor). Turn it off so the controller
            // sends key events (D-pad, A, B, ...) that the shared web app maps in js/nav/gamepad.js.
            // Source: Microsoft Learn, "Gamepad and remote control interactions", Mouse mode.
            this.RequiresPointerMode = ApplicationRequiresPointerMode.WhenRequested;

            // Chromium switches for the web view. They must be set before the first WebView2 exists.
            //  - HardwareMediaKeyHandling off: media-remote buttons are handled here through the system media
            //    controls (MainPage.xaml.cs) instead, as Microsoft's Xbox media sample does, because the web
            //    view's own handling is inconsistent on the console.
            //  - autoplay-policy: playback starts from a controller press that the page then sends over the
            //    network first; do not let the user-gesture rule refuse the play() that follows.
            string args = "--disable-features=HardwareMediaKeyHandling --autoplay-policy=no-user-gesture-required";
#if DEBUG
            // Lets Microsoft Edge (edge://inspect) attach DevTools to the running app on the console.
            // Debug builds only: never in a package that goes to the Store.
            args += " --enable-features=msEdgeDevToolsWdpRemoteDebugging";
#endif
            Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args);

            // The colour shown while a page loads: the app's own background, so there is no white flash.
            Environment.SetEnvironmentVariable("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "FF0B0D12");

            // UWP apps are scaled 2x on Xbox by default (a 960x540 layout). Turn that off: the web app lays itself
            // out on a 1920x1080 canvas and scales it, so it wants the real pixels.
            if (!ApplicationViewScaling.TrySetDisableLayoutScaling(true))
            {
                Debug.WriteLine("Beebo: could not disable layout scaling.");
            }
        }

        protected override void OnLaunched(LaunchActivatedEventArgs e)
        {
            Frame rootFrame = Window.Current.Content as Frame;
            if (rootFrame == null)
            {
                rootFrame = new Frame();
                rootFrame.NavigationFailed += OnNavigationFailed;
                Window.Current.Content = rootFrame;
            }

            if (e.PrelaunchActivated == false)
            {
                if (rootFrame.Content == null)
                {
                    rootFrame.Navigate(typeof(MainPage), e.Arguments);
                }
                Window.Current.Activate();
            }
        }

        void OnNavigationFailed(object sender, NavigationFailedEventArgs e)
        {
            throw new Exception("Failed to load Page " + e.SourcePageType.FullName);
        }

        private void OnSuspending(object sender, SuspendingEventArgs e)
        {
            // Nothing to save: the web app keeps its own state in localStorage, and playback progress is reported
            // to the server as it happens.
            var deferral = e.SuspendingOperation.GetDeferral();
            deferral.Complete();
        }
    }
}
