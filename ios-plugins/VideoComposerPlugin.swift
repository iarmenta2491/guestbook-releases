import Foundation
import Capacitor
import AVFoundation

@objc(VideoComposerPlugin)
public class VideoComposerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VideoComposerPlugin"
    public let jsName = "VideoComposer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "compose", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]
    
    private var currentExportSession: AVAssetExportSession?
    
    @objc func compose(_ call: CAPPluginCall) {
        guard let clipsArray = call.getArray("clips") as? [[String: Any]],
              !clipsArray.isEmpty else {
            call.reject("No clips provided")
            return
        }
        
        let outputPathStr = call.getString("outputPath") ?? "output.mp4"
        let resolution = call.getObject("resolution") ?? ["width": 1280, "height": 720]
        let targetWidth = resolution["width"] as? Int ?? 1280
        let targetHeight = resolution["height"] as? Int ?? 720
        let bgMusicPath = call.getString("bgMusicPath") ?? ""
        let bgMusicVolume = call.getFloat("bgMusicVolume") ?? 0.1
        let transitionsArray = call.getArray("transitions") as? [[String: Any]] ?? []
        
        // Parse clips
        var clips: [(url: URL, trimStart: CMTime, trimEnd: CMTime)] = []
        for clipDict in clipsArray {
            guard let pathStr = clipDict["path"] as? String else { continue }
            let sanitized = pathStr
                .replacingOccurrences(of: "file://", with: "")
            guard let url = URL(fileURLWithPath: sanitized).standardized as URL?,
                  FileManager.default.fileExists(atPath: url.path) else {
                call.reject("Clip not found: \(pathStr)")
                return
            }
            let trimStartMs = clipDict["trimStartMs"] as? Int64 ?? 0
            let trimEndMs = clipDict["trimEndMs"] as? Int64 ?? 0
            let startTime = CMTime(value: trimStartMs, timescale: 1000)
            let endTime = trimEndMs > 0 ? CMTime(value: trimEndMs, timescale: 1000) : CMTime.invalid
            clips.append((url: url, trimStart: startTime, trimEnd: endTime))
        }
        
        // Parse transitions
        var transitions: [(type: String, durationMs: Int)] = []
        for t in transitionsArray {
            let type = t["type"] as? String ?? "none"
            let duration = t["durationMs"] as? Int ?? 500
            transitions.append((type: type, durationMs: duration))
        }
        
        // Output file
        let exportDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("exports")
        try? FileManager.default.createDirectory(at: exportDir, withIntermediateDirectories: true)
        
        let outputFilename = outputPathStr.contains("/") 
            ? String(outputPathStr.split(separator: "/").last ?? "output.mp4")
            : outputPathStr
        let outputURL = exportDir.appendingPathComponent(outputFilename)
        
        // Remove existing file
        try? FileManager.default.removeItem(at: outputURL)
        
        // Run composition on background queue
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.performComposition(
                clips: clips,
                transitions: transitions,
                outputURL: outputURL,
                targetSize: CGSize(width: targetWidth, height: targetHeight),
                call: call
            )
        }
    }
    
    @objc func cancel(_ call: CAPPluginCall) {
        currentExportSession?.cancelExport()
        call.resolve()
    }
    
    private func performComposition(
        clips: [(url: URL, trimStart: CMTime, trimEnd: CMTime)],
        transitions: [(type: String, durationMs: Int)],
        outputURL: URL,
        targetSize: CGSize,
        call: CAPPluginCall
    ) {
        let composition = AVMutableComposition()
        
        guard let videoTrack = composition.addMutableTrack(
            withMediaType: .video,
            preferredTrackID: kCMPersistentTrackID_Invalid
        ),
        let audioTrack = composition.addMutableTrack(
            withMediaType: .audio,
            preferredTrackID: kCMPersistentTrackID_Invalid
        ) else {
            call.reject("Failed to create composition tracks")
            return
        }
        
        var currentTime = CMTime.zero
        
        for (index, clip) in clips.enumerated() {
            let asset = AVAsset(url: clip.url)
            
            // Determine time range
            let assetDuration = asset.duration
            let startTime = clip.trimStart
            let endTime = clip.trimEnd.isValid ? clip.trimEnd : assetDuration
            let timeRange = CMTimeRange(start: startTime, end: endTime)
            
            // Insert video track
            if let sourceVideoTrack = asset.tracks(withMediaType: .video).first {
                do {
                    try videoTrack.insertTimeRange(timeRange, of: sourceVideoTrack, at: currentTime)
                } catch {
                    call.reject("Failed to insert video track for clip \(index): \(error.localizedDescription)")
                    return
                }
            }
            
            // Insert audio track
            if let sourceAudioTrack = asset.tracks(withMediaType: .audio).first {
                do {
                    try audioTrack.insertTimeRange(timeRange, of: sourceAudioTrack, at: currentTime)
                } catch {
                    // Audio track failure is non-fatal
                    print("[VideoComposer] Warning: failed to insert audio for clip \(index)")
                }
            }
            
            currentTime = CMTimeAdd(currentTime, timeRange.duration)
            
            // Report progress
            let progress = Float(index + 1) / Float(clips.count) * 0.8 // 80% for composition
            self.notifyListeners("composeProgress", data: ["progress": progress])
        }
        
        // Create video composition for scaling/fitting to target resolution
        let videoComposition = AVMutableVideoComposition()
        videoComposition.renderSize = targetSize
        videoComposition.frameDuration = CMTime(value: 1, timescale: 30) // 30fps
        
        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = CMTimeRange(start: .zero, duration: composition.duration)
        
        let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
        
        // Scale video to fit target size (letterbox)
        let videoSize = videoTrack.naturalSize
        let transform = videoTrack.preferredTransform
        var adjustedSize = videoSize.applying(transform)
        adjustedSize = CGSize(width: abs(adjustedSize.width), height: abs(adjustedSize.height))
        
        let scaleX = targetSize.width / adjustedSize.width
        let scaleY = targetSize.height / adjustedSize.height
        let scale = min(scaleX, scaleY)
        let scaledWidth = adjustedSize.width * scale
        let scaledHeight = adjustedSize.height * scale
        let offsetX = (targetSize.width - scaledWidth) / 2
        let offsetY = (targetSize.height - scaledHeight) / 2
        
        var finalTransform = transform
        finalTransform = finalTransform.concatenating(CGAffineTransform(scaleX: scale, y: scale))
        finalTransform = finalTransform.concatenating(CGAffineTransform(translationX: offsetX, y: offsetY))
        layerInstruction.setTransform(finalTransform, at: .zero)
        
        instruction.layerInstructions = [layerInstruction]
        videoComposition.instructions = [instruction]
        
        // Export
        guard let exportSession = AVAssetExportSession(
            asset: composition,
            presetName: AVAssetExportPresetHighestQuality
        ) else {
            call.reject("Failed to create export session")
            return
        }
        
        currentExportSession = exportSession
        exportSession.outputURL = outputURL
        exportSession.outputFileType = .mp4
        exportSession.videoComposition = videoComposition
        exportSession.shouldOptimizeForNetworkUse = true // faststart equivalent
        
        // Progress polling
        let progressTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] timer in
            let progress = 0.8 + Double(exportSession.progress) * 0.2 // Last 20% for export
            self?.notifyListeners("composeProgress", data: ["progress": progress])
            if exportSession.status != .exporting {
                timer.invalidate()
            }
        }
        RunLoop.current.add(progressTimer, forMode: .common)
        
        exportSession.exportAsynchronously { [weak self] in
            progressTimer.invalidate()
            
            switch exportSession.status {
            case .completed:
                self?.notifyListeners("composeProgress", data: ["progress": 1.0])
                var result = JSObject()
                result["outputPath"] = outputURL.path
                result["outputUri"] = outputURL.absoluteString
                result["durationMs"] = CMTimeGetSeconds(composition.duration) * 1000
                call.resolve(result)
            case .cancelled:
                call.reject("Export cancelled")
            case .failed:
                call.reject("Export failed: \(exportSession.error?.localizedDescription ?? "Unknown error")")
            default:
                call.reject("Export ended with unexpected status")
            }
        }
    }
}
