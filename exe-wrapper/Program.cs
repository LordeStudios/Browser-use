using System;
using System.Diagnostics;
using System.IO;
using System.Linq;

class Program {
    static int Main(string[] args) {
        var exeDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        var nodePath = FindNode();
        var scriptPath = Path.Combine(exeDir, "src", "index.js");
        if (!File.Exists(scriptPath)) {
            Console.Error.WriteLine($"browser-use script not found: {scriptPath}");
            return 1;
        }
        var psi = new ProcessStartInfo {
            FileName = nodePath,
            Arguments = $"\"{scriptPath}\" {string.Join(" ", args.Select(a => $"\"{a}\""))}",
            WorkingDirectory = exeDir,
            UseShellExecute = false,
            RedirectStandardOutput = false,
            RedirectStandardError = false
        };
        using (var proc = Process.Start(psi)) {
            proc.WaitForExit();
            return proc.ExitCode;
        }
    }

    static string FindNode() {
        var env = Environment.GetEnvironmentVariable("NODE_PATH");
        if (!string.IsNullOrEmpty(env) && File.Exists(env)) return env;
        var path = Environment.GetEnvironmentVariable("PATH");
        foreach (var dir in path.Split(Path.PathSeparator)) {
            var candidate = Path.Combine(dir, "node.exe");
            if (File.Exists(candidate)) return candidate;
        }
        var local = Path.Combine(Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location), "node.exe");
        if (File.Exists(local)) return local;
        throw new FileNotFoundException("node.exe not found in PATH");
    }
}
