// Harnais du banc d'essai WebKit (cf. run.js) : un vrai WKWebView — le moteur de Safari, et
// de DuckDuckGo, sur Mac — piloté par des lignes JSON sur stdin / stdout.
//   → {"id":1,"op":"load","url":"http://127.0.0.1:3090/?e=…&g=…"}
//   → {"id":2,"op":"eval","js":"return JSON.stringify({ file: queue.length })"}
//   ← {"id":2,"ok":true,"value":"{\"file\":0}"}      ← {"ev":"log","msg":"…"}
// Rien ne s'affiche : fenêtre sans bordure placée hors écran, application sans icône dans
// le Dock, jamais activée.
import Cocoa
import WebKit

setvbuf(stdout, nil, _IONBF, 0)

final class Lab: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    var webView: WKWebView!
    var window: NSWindow!

    func emit(_ obj: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: d, encoding: .utf8) else { return }
        print(s)
    }

    func start(userScript: String) {
        let cfg = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        ucc.add(self, name: "lab")
        ucc.addUserScript(WKUserScript(source: userScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController = ucc
        cfg.websiteDataStore = WKWebsiteDataStore.default() // persistant : requis pour un service worker
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 390, height: 780), configuration: cfg)
        webView.navigationDelegate = self
        // Sans ça, une fenêtre hors écran rend la page « cachée » : minuteries ralenties, et
        // la page opérateur ne se reconnecte pas quand elle se croit en arrière-plan.
        webView.setValue(false, forKey: "windowOcclusionDetectionEnabled")
        window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 390, height: 780),
                          styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = webView
        window.orderFrontRegardless()
        emit(["ev": "ready"])
    }

    func handle(_ cmd: [String: Any]) {
        let id = cmd["id"] ?? NSNull()
        switch cmd["op"] as? String {
        case "load":
            guard let s = cmd["url"] as? String, let url = URL(string: s) else { emit(["id": id, "ok": false, "error": "url"]); return }
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
            emit(["id": id, "ok": true, "value": "loading"])
        case "eval": // corps de fonction asynchrone, exécuté dans la page ; doit rendre une chaîne
            let js = cmd["js"] as? String ?? ""
            webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
                switch result {
                case .success(let v): self.emit(["id": id, "ok": true, "value": (v as? String) ?? "\(v)"])
                case .failure(let e): self.emit(["id": id, "ok": false, "error": "\(e)"])
                }
            }
        case "wipe": // service workers, caches, localStorage : tout ce que ce banc a stocké
            let types = WKWebsiteDataStore.allWebsiteDataTypes()
            WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: Date(timeIntervalSince1970: 0)) {
                self.emit(["id": id, "ok": true, "value": "wiped"])
            }
        case "quit":
            emit(["id": id, "ok": true, "value": "bye"])
            exit(0)
        default:
            emit(["id": id, "ok": false, "error": "op inconnue"])
        }
    }

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        emit(["ev": "log", "msg": "\(message.body)"])
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        emit(["ev": "nav", "what": "didFinish", "url": webView.url?.absoluteString ?? ""])
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        emit(["ev": "nav", "what": "didFail", "error": error.localizedDescription])
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        emit(["ev": "nav", "what": "didFailProvisional", "error": error.localizedDescription])
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        emit(["ev": "nav", "what": "webContentProcessDidTerminate"])
    }
}

let userScriptPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
let userScript = (try? String(contentsOfFile: userScriptPath, encoding: .utf8)) ?? ""

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
// App Nap ralentirait les minuteries d'un processus sans fenêtre visible.
let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical], reason: "banc d'essai")
let lab = Lab()
lab.start(userScript: userScript)

DispatchQueue.global().async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let cmd = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
        DispatchQueue.main.async { lab.handle(cmd) }
    }
    DispatchQueue.main.async { exit(0) } // stdin fermé : le banc s'est arrêté
}
app.run()
_ = activity
