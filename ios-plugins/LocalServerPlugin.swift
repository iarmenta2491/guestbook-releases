import Foundation
import Capacitor
import Network

@objc(LocalServerPlugin)
public class LocalServerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LocalServerPlugin"
    public let jsName = "LocalServer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLocalIP", returnType: CAPPluginReturnPromise)
    ]
    
    private var httpServer: SimpleHTTPServer?
    
    @objc func start(_ call: CAPPluginCall) {
        let directoryPath = (call.getString("directoryPath") ?? "")
            .replacingOccurrences(of: "file://", with: "")
        let port = call.getInt("port") ?? 8080
        let downloadPageHtml = call.getString("downloadPageHtml") ?? ""
        
        let rootDir = URL(fileURLWithPath: directoryPath)
        guard FileManager.default.fileExists(atPath: rootDir.path) else {
            call.reject("Directory does not exist: \(directoryPath)")
            return
        }
        
        // Stop existing server
        httpServer?.stop()
        
        httpServer = SimpleHTTPServer(port: UInt16(port), rootDirectory: rootDir, downloadPageHtml: downloadPageHtml)
        httpServer?.start()
        
        let ip = getLocalIPAddress()
        
        var result = JSObject()
        result["url"] = "http://\(ip):\(port)"
        result["ip"] = ip
        result["port"] = port
        call.resolve(result)
    }
    
    @objc func stop(_ call: CAPPluginCall) {
        httpServer?.stop()
        httpServer = nil
        call.resolve()
    }
    
    @objc func getLocalIP(_ call: CAPPluginCall) {
        var result = JSObject()
        result["ip"] = getLocalIPAddress()
        call.resolve(result)
    }
    
    private func getLocalIPAddress() -> String {
        var address = "127.0.0.1"
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else { return address }
        defer { freeifaddrs(ifaddr) }
        
        for ptr in sequence(first: firstAddr, next: { $0.pointee.ifa_next }) {
            let interface = ptr.pointee
            let addrFamily = interface.ifa_addr.pointee.sa_family
            guard addrFamily == UInt8(AF_INET) else { continue }
            
            let name = String(cString: interface.ifa_name)
            guard name == "en0" || name == "en1" else { continue } // WiFi interfaces
            
            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            getnameinfo(
                interface.ifa_addr, socklen_t(interface.ifa_addr.pointee.sa_len),
                &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST
            )
            address = String(cString: hostname)
            break
        }
        return address
    }
    
    deinit {
        httpServer?.stop()
    }
}

// MARK: - Simple HTTP Server using Foundation sockets
// This avoids needing GCDWebServer as a dependency for initial implementation.
// For production, consider replacing with GCDWebServer for better Range support.

class SimpleHTTPServer {
    private let port: UInt16
    private let rootDirectory: URL
    private let downloadPageHtml: String
    private var serverSocket: Int32 = -1
    private var isRunning = false
    private let queue = DispatchQueue(label: "com.myguestbook.httpserver", attributes: .concurrent)
    
    init(port: UInt16, rootDirectory: URL, downloadPageHtml: String) {
        self.port = port
        self.rootDirectory = rootDirectory
        self.downloadPageHtml = downloadPageHtml.isEmpty ? Self.defaultDownloadPage : downloadPageHtml
    }
    
    func start() {
        isRunning = true
        queue.async { [weak self] in
            self?.runServer()
        }
    }
    
    func stop() {
        isRunning = false
        if serverSocket >= 0 {
            close(serverSocket)
            serverSocket = -1
        }
    }
    
    private func runServer() {
        serverSocket = socket(AF_INET, SOCK_STREAM, 0)
        guard serverSocket >= 0 else { return }
        
        var yes: Int32 = 1
        setsockopt(serverSocket, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr = in_addr(s_addr: INADDR_ANY)
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        
        let bindResult = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(serverSocket, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else {
            print("[LocalServer] Bind failed on port \(port)")
            return
        }
        
        listen(serverSocket, 10)
        print("[LocalServer] Listening on port \(port)")
        
        while isRunning {
            var clientAddr = sockaddr_in()
            var clientLen = socklen_t(MemoryLayout<sockaddr_in>.size)
            let clientSocket = withUnsafeMutablePointer(to: &clientAddr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    accept(serverSocket, $0, &clientLen)
                }
            }
            guard clientSocket >= 0 else { continue }
            
            queue.async { [weak self] in
                self?.handleClient(clientSocket)
            }
        }
    }
    
    private func handleClient(_ socket: Int32) {
        defer { close(socket) }
        
        // Read request (simple HTTP/1.1 parsing)
        var buffer = [UInt8](repeating: 0, count: 8192)
        let bytesRead = recv(socket, &buffer, buffer.count, 0)
        guard bytesRead > 0 else { return }
        
        let request = String(bytes: buffer[0..<bytesRead], encoding: .utf8) ?? ""
        let lines = request.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return }
        let parts = requestLine.components(separatedBy: " ")
        guard parts.count >= 2 else { return }
        
        let method = parts[0]
        let fullPath = parts[1]
        
        // Parse headers for Range support
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            if line.isEmpty { break }
            let headerParts = line.components(separatedBy: ": ")
            if headerParts.count == 2 {
                headers[headerParts[0].lowercased()] = headerParts[1]
            }
        }
        
        // Parse URI and query string
        let urlComponents = fullPath.components(separatedBy: "?")
        let uri = urlComponents[0]
        var queryParams: [String: String] = [:]
        if urlComponents.count > 1 {
            let queryString = urlComponents[1]
            for param in queryString.components(separatedBy: "&") {
                let kv = param.components(separatedBy: "=")
                if kv.count == 2 {
                    queryParams[kv[0]] = kv[1].removingPercentEncoding ?? kv[1]
                }
            }
        }
        
        if uri == "/download" {
            let filename = queryParams["file"] ?? ""
            let html = downloadPageHtml
                .replacingOccurrences(of: "{{FILENAME}}", with: filename)
                .replacingOccurrences(of: "{{VIDEO_URL}}", with: "/video?file=\(filename)")
            sendHTTPResponse(socket: socket, status: "200 OK", contentType: "text/html", body: html.data(using: .utf8)!)
        } else if uri.hasPrefix("/video") {
            let filename = (queryParams["file"] ?? "").components(separatedBy: "/").last ?? ""
            guard !filename.isEmpty else {
                sendHTTPResponse(socket: socket, status: "400 Bad Request", contentType: "text/plain", body: "No file".data(using: .utf8)!)
                return
            }
            let fileURL = rootDirectory.appendingPathComponent(filename)
            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                sendHTTPResponse(socket: socket, status: "404 Not Found", contentType: "text/plain", body: "Not found".data(using: .utf8)!)
                return
            }
            serveFile(socket: socket, fileURL: fileURL, rangeHeader: headers["range"])
        } else {
            sendHTTPResponse(socket: socket, status: "200 OK", contentType: "text/plain", body: "My Guestbook Server".data(using: .utf8)!)
        }
    }
    
    private func serveFile(socket: Int32, fileURL: URL, rangeHeader: String?) {
        guard let fileHandle = try? FileHandle(forReadingFrom: fileURL) else {
            sendHTTPResponse(socket: socket, status: "500 Internal Server Error", contentType: "text/plain", body: "Cannot open file".data(using: .utf8)!)
            return
        }
        defer { fileHandle.closeFile() }
        
        let fileSize = (try? FileManager.default.attributesOfItem(atPath: fileURL.path))?[.size] as? UInt64 ?? 0
        let mimeType = fileURL.pathExtension == "mp4" ? "video/mp4" : "application/octet-stream"
        let filename = fileURL.lastPathComponent
        
        // Handle Range request
        if let range = rangeHeader, range.hasPrefix("bytes=") {
            let rangeStr = range.replacingOccurrences(of: "bytes=", with: "")
            let rangeParts = rangeStr.components(separatedBy: "-")
            let start = UInt64(rangeParts[0]) ?? 0
            let end = rangeParts.count > 1 && !rangeParts[1].isEmpty ? (UInt64(rangeParts[1]) ?? (fileSize - 1)) : (fileSize - 1)
            let contentLength = end - start + 1
            
            fileHandle.seek(toFileOffset: start)
            let data = fileHandle.readData(ofLength: Int(contentLength))
            
            let header = "HTTP/1.1 206 Partial Content\r\n" +
                "Content-Type: \(mimeType)\r\n" +
                "Content-Length: \(contentLength)\r\n" +
                "Content-Range: bytes \(start)-\(end)/\(fileSize)\r\n" +
                "Accept-Ranges: bytes\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Connection: close\r\n\r\n"
            send(socket, header, header.count, 0)
            data.withUnsafeBytes { send(socket, $0.baseAddress!, data.count, 0) }
        } else {
            // Full file
            let header = "HTTP/1.1 200 OK\r\n" +
                "Content-Type: \(mimeType)\r\n" +
                "Content-Length: \(fileSize)\r\n" +
                "Content-Disposition: attachment; filename=\"\(filename)\"\r\n" +
                "Accept-Ranges: bytes\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Connection: close\r\n\r\n"
            send(socket, header, header.count, 0)
            
            // Stream file in chunks
            let chunkSize = 64 * 1024 // 64KB
            while true {
                let chunk = fileHandle.readData(ofLength: chunkSize)
                if chunk.isEmpty { break }
                chunk.withUnsafeBytes { send(socket, $0.baseAddress!, chunk.count, 0) }
            }
        }
    }
    
    private func sendHTTPResponse(socket: Int32, status: String, contentType: String, body: Data) {
        let header = "HTTP/1.1 \(status)\r\n" +
            "Content-Type: \(contentType)\r\n" +
            "Content-Length: \(body.count)\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Connection: close\r\n\r\n"
        send(socket, header, header.count, 0)
        body.withUnsafeBytes { send(socket, $0.baseAddress!, body.count, 0) }
    }
    
    static let defaultDownloadPage = """
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Your Message</title>
      <style>
        body{background:#07071a;color:#fff;font-family:-apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}
        h1{font-size:1.5rem;margin-bottom:12px}
        p{color:rgba(255,255,255,.6);margin-bottom:24px}
        video{width:100%;max-width:480px;border-radius:16px;margin-bottom:24px}
        a.btn{display:inline-flex;align-items:center;gap:8px;padding:16px 32px;background:linear-gradient(135deg,#8b5cf6,#2dd4bf);color:#fff;border-radius:50px;text-decoration:none;font-weight:700;font-size:1.1rem}
      </style>
    </head>
    <body>
      <h1>🎬 Your Message</h1>
      <p>Tap below to save your video</p>
      <video src="{{VIDEO_URL}}" controls playsinline webkit-playsinline></video>
      <a class="btn" href="{{VIDEO_URL}}" download="{{FILENAME}}">⬇️ Save Video</a>
    </body></html>
    """
}
