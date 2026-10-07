using System;
using System.Collections.Generic;
using System.IO;

namespace WandEnhancer.Core
{
    /// <summary>
    /// Log of the patch run that produced the current install, saved next to app.asar.
    /// The remote bridge prints it in Wand's DevTools console, so it must stay outside the archive:
    /// the enablement step logs after app.asar is already packed.
    /// </summary>
    internal sealed class PatchRunLog
    {
        /// <summary>Read by the bridge as PATCH_LOG_FILE_NAME in web-panel/bridge/src/constants.ts.</summary>
        public const string FileName = "wand-enhancer-patch.log";

        private readonly List<string> _lines = new List<string>();

        public void Begin(string header)
        {
            _lines.Clear();
            _lines.Add($"=== {DateTime.Now:yyyy-MM-dd} {header}");
        }

        public void Add(string message, ELogType type)
        {
            _lines.Add($"{DateTime.Now:HH:mm:ss.fff} [{type.ToString().ToUpperInvariant()}] {message}");
        }

        public void Save(string resourcesDirectory)
        {
            File.WriteAllLines(Path.Combine(resourcesDirectory, FileName), _lines);
        }

        public static void Delete(string resourcesDirectory)
        {
            string path = Path.Combine(resourcesDirectory, FileName);
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
    }
}
