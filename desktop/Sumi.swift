import Cocoa
import WebKit

final class SumiApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var server: Process?
    private var origin: URL?
    private var outputBuffer = ""
    private var log: FileHandle?
    private var stopping = false
    private var downloads: [WKDownload] = []
    private let dataDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Sumi", isDirectory: true)

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        // A random backend port must not reset appearance/privacy preferences each launch.
        let savedJSON: String = {
            guard let raw = UserDefaults.standard.string(forKey: "journalPreferences")?.data(using: .utf8),
                  let parsed = try? JSONSerialization.jsonObject(with: raw) as? [String: String] else { return "{}" }
            let filtered = parsed.filter { $0.key.hasPrefix("journal-") }
            guard let reserialized = try? JSONSerialization.data(withJSONObject: filtered),
                  let string = String(data: reserialized, encoding: .utf8) else { return "{}" }
            return string
        }()
        let preferences = WKUserScript(source: """
        (() => {
          const saved = \(savedJSON);
          const stale = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('journal-') && !Object.prototype.hasOwnProperty.call(saved, k)) stale.push(k);
          }
          for (const k of stale) localStorage.removeItem(k);
          for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
          const persist = () => {
            const values = {};
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (key && key.startsWith('journal-')) values[key] = localStorage.getItem(key);
            }
            window.webkit.messageHandlers.preferences.postMessage(values);
          };
          const setItem = Storage.prototype.setItem;
          Storage.prototype.setItem = function(key, value) { setItem.call(this, key, value); persist(); };
          const removeItem = Storage.prototype.removeItem;
          Storage.prototype.removeItem = function(key) { removeItem.call(this, key); persist(); };
          const clear = Storage.prototype.clear;
          Storage.prototype.clear = function() { clear.call(this); persist(); };
        })();
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        configuration.userContentController.addUserScript(preferences)
        configuration.userContentController.add(self, name: "preferences")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 920),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Sumi"
        window.minSize = NSSize(width: 900, height: 620)
        window.backgroundColor = NSColor(calibratedRed: 0.961, green: 0.957, blue: 0.929, alpha: 1)
        window.contentView = webView
        window.setFrameAutosaveName("SumiMainWindow")
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        webView.loadHTMLString("""
        <html><body style="background:#f5f4ed;color:#1b365d;display:grid;place-content:center;height:90vh;text-align:center;font-family:Georgia">
        <h1 style="font-weight:400;font-size:40px;margin-bottom:12px">Sumi</h1>
        <p style="color:#6b6a64">Opening your trading journal…</p></body></html>
        """, baseURL: nil)
        startServer()
    }

    private func startServer() {
        do {
            try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            let logURL = dataDirectory.appendingPathComponent("desktop.log")
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
            log = try FileHandle(forWritingTo: logURL)
            guard let resources = Bundle.main.resourceURL else { throw CocoaError(.fileNoSuchFile) }
            let process = Process()
            process.executableURL = resources.appendingPathComponent("runtime/node")
            process.arguments = [resources.appendingPathComponent("launch.cjs").path]
            process.currentDirectoryURL = dataDirectory
            // Do not inherit NODE_OPTIONS or unrelated shell environment into a packaged app.
            process.environment = [
                "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": NSHomeDirectory(),
                "TMPDIR": NSTemporaryDirectory(), "JOURNAL_DATA_DIR": dataDirectory.path,
                "LANG": "en_US.UTF-8"
            ]
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty else { handle.readabilityHandler = nil; return }
                DispatchQueue.main.async { self?.receiveOutput(data) }
            }
            process.terminationHandler = { [weak self] process in
                DispatchQueue.main.async {
                    guard let self = self, !self.stopping else { return }
                    self.fail("The local journal server stopped (exit \(process.terminationStatus)). Your data is still saved. See desktop.log in your journal data folder.")
                }
            }
            server = process
            try process.run()
        } catch {
            fail("Could not start the journal: \(error.localizedDescription)")
        }
    }

    private func receiveOutput(_ data: Data) {
        try? log?.write(contentsOf: data)
        outputBuffer += String(decoding: data, as: UTF8.self)
        while let newline = outputBuffer.firstIndex(of: "\n") {
            let line = String(outputBuffer[..<newline])
            outputBuffer.removeSubrange(...newline)
            if line.hasPrefix("SUMI_READY "), origin == nil,
               let url = URL(string: String(line.dropFirst(11))),
               url.scheme == "http", url.host == "127.0.0.1", url.port != nil {
                origin = url
                webView.load(URLRequest(url: url))
            }
        }
        if outputBuffer.count > 16384 { outputBuffer = String(outputBuffer.suffix(16384)) }
    }

    private func fail(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Sumi could not open"
        alert.informativeText = message
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Show data folder")
        if alert.runModal() == .alertSecondButtonReturn { showDataFolder() }
        NSApp.terminate(nil)
    }

    private func isLocal(_ url: URL) -> Bool {
        guard let origin = origin else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
    }

    private func isTrustedMainFrame(_ frame: WKFrameInfo) -> Bool {
        guard frame.isMainFrame, let url = frame.request.url else { return false }
        return isLocal(url)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.absoluteString == "about:blank" { decisionHandler(.allow); return }
        if isLocal(url) || url.scheme == "blob" {
            decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
        } else {
            let isTrusted = isTrustedMainFrame(navigationAction.sourceFrame)
            if isTrusted && navigationAction.navigationType == .linkActivated && ["https", "http", "mailto"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        let isTrusted = isTrustedMainFrame(navigationAction.sourceFrame)
        if let url = navigationAction.request.url, isLocal(url) {
            webView.load(navigationAction.request)
        } else if isTrusted, let url = navigationAction.request.url, ["https", "http"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        downloads.append(download)
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        downloads.append(download)
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        let fallback = (response.suggestedFilename?.isEmpty ?? true) ? "download" : (response.suggestedFilename ?? "download")
        let filename = suggestedFilename.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? fallback : suggestedFilename
        panel.nameFieldStringValue = URL(fileURLWithPath: filename).lastPathComponent
        panel.beginSheetModal(for: window) { result in
            completionHandler(result == .OK ? panel.url : nil)
        }
    }

    func downloadDidFinish(_ download: WKDownload) { downloads.removeAll { $0 === download } }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeAll { $0 === download }
        if (error as NSError).code != NSURLErrorCancelled { showAlert("Download failed", error.localizedDescription) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        showAlert("Sumi", message)
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    @available(macOS 12.0, *)
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        // Allow microphone capture only for the trusted local main frame with exact loopback origin.
        // Camera access is strictly denied. Operating system TCC permission is still enforced by macOS.
        guard frame.isMainFrame else {
            decisionHandler(.deny)
            return
        }
        guard type == .microphone else {
            decisionHandler(.deny)
            return
        }
        guard let appOrigin = self.origin,
              let appPort = appOrigin.port,
              origin.protocol == appOrigin.scheme,
              origin.host == appOrigin.host,
              origin.port == appPort else {
            decisionHandler(.deny)
            return
        }
        if let frameURL = frame.request.url, !isLocal(frameURL) {
            decisionHandler(.deny)
            return
        }
        decisionHandler(.grant)
    }

    private func showAlert(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.runModal()
    }

    private func buildMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "About Sumi", action: #selector(about), keyEquivalent: "")
        appMenu.addItem(withTitle: "Show Journal Data", action: #selector(showDataFolder), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Sumi", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Sumi", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem()
        menu.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        editItem.submenu = edit
        for (title, selector, key, mask) in [
            ("Undo", "undo:", "z", NSEvent.ModifierFlags.command),
            ("Redo", "redo:", "Z", [.command, .shift]),
            ("Cut", "cut:", "x", .command),
            ("Copy", "copy:", "c", .command),
            ("Paste", "paste:", "v", .command),
            ("Select All", "selectAll:", "a", .command)
        ] {
            let item = edit.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
            item.keyEquivalentModifierMask = mask
        }
        let viewItem = NSMenuItem()
        menu.addItem(viewItem)
        let view = NSMenu(title: "View")
        viewItem.submenu = view
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: "Actual Size", action: #selector(resetZoom), keyEquivalent: "0")
        view.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "+")
        view.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
        let windowItem = NSMenuItem()
        menu.addItem(windowItem)
        let windowMenu = NSMenu(title: "Window")
        windowItem.submenu = windowMenu
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        NSApp.windowsMenu = windowMenu
        NSApp.mainMenu = menu
        for submenu in [appMenu, view] {
            for item in submenu.items where item.action != #selector(NSApplication.terminate(_:)) && item.action != #selector(NSApplication.hide(_:)) {
                item.target = self
            }
        }
    }

    @objc private func about() {
        showAlert("Sumi", "A local trading journal.\n\nBuilt on LuxAlgo's MIT-licensed Trade Journal, with a Kami-inspired theme (Tw93). Not affiliated with or endorsed by either project.\n\nThird-party license notices are bundled in Contents/Resources/licenses.")
    }
    @objc private func showDataFolder() { NSWorkspace.shared.open(dataDirectory) }
    @objc private func reload() { webView.reload() }
    @objc private func resetZoom() { webView.pageZoom = 1 }
    @objc private func zoomIn() { webView.pageZoom = min(2, webView.pageZoom + 0.1) }
    @objc private func zoomOut() { webView.pageZoom = max(0.6, webView.pageZoom - 0.1) }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        stopping = true
        for download in downloads { download.cancel() }
        downloads.removeAll()
        guard let server = server, server.isRunning else { return .terminateNow }
        webView.stopLoading()
        server.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
            if server.isRunning { kill(server.processIdentifier, SIGKILL) }
        }
        DispatchQueue.global().async {
            server.waitUntilExit()
            DispatchQueue.main.async { NSApp.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }
}

extension SumiApp: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url, isLocal(url),
              let values = message.body as? [String: String],
              values.allSatisfy({ $0.key.hasPrefix("journal-") }),
              let data = try? JSONSerialization.data(withJSONObject: values), data.count < 65536,
              let json = String(data: data, encoding: .utf8) else { return }
        UserDefaults.standard.set(json, forKey: "journalPreferences")
    }
}

let app = NSApplication.shared
let delegate = SumiApp()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
