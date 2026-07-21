using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

internal static class WaveLibraryConverter
{
    private const string MonolithicKind = "VisualWaveDromWaveLibrary";
    private const string SplitKind = "VisualWaveDromSplitWaveLibrary";
    private const string ManifestFileName = "library.json";
    private static readonly UTF8Encoding Utf8NoBom = new UTF8Encoding(false);

    private static int Main(string[] args)
    {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = Encoding.UTF8;
        bool interactive = args.Length == 0 || (args.Length == 1 && PathExists(Unquote(args[0])));
        try
        {
            PrintBanner();
            int result = Run(args, interactive);
            if (interactive)
            {
                Console.WriteLine();
                Console.Write("按任意键关闭...");
                Console.ReadKey(true);
            }
            return result;
        }
        catch (Exception error)
        {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine("转换失败：" + error.Message);
            Console.ResetColor();
            if (interactive)
            {
                Console.WriteLine();
                Console.Write("按任意键关闭...");
                Console.ReadKey(true);
            }
            return 1;
        }
    }

    private static int Run(string[] originalArgs, bool interactive)
    {
        List<string> args = new List<string>();
        bool force = false;
        foreach (string raw in originalArgs)
        {
            if (string.Equals(raw, "--force", StringComparison.OrdinalIgnoreCase) || raw == "-f") force = true;
            else args.Add(raw);
        }

        if (args.Count > 0 && IsHelp(args[0]))
        {
            PrintHelp();
            return 0;
        }

        string command = "auto";
        string source = null;
        string target = null;
        if (args.Count > 0 && IsCommand(args[0]))
        {
            command = args[0].ToLowerInvariant();
            if (args.Count > 1) source = Unquote(args[1]);
            if (args.Count > 2) target = Unquote(args[2]);
        }
        else
        {
            if (args.Count > 0) source = Unquote(args[0]);
            if (args.Count > 1) target = Unquote(args[1]);
        }

        if (string.IsNullOrWhiteSpace(source))
        {
            Console.Write("请输入或拖入波形库 JSON/拆分库目录：");
            source = Unquote(Console.ReadLine());
        }
        if (string.IsNullOrWhiteSpace(source)) throw new InvalidOperationException("未提供源波形库");
        source = Path.GetFullPath(source);

        if (command == "auto") command = DetectCommand(source);
        if (command == "verify")
        {
            Verify(source);
            return 0;
        }

        if (string.IsNullOrWhiteSpace(target))
        {
            target = command == "unpack" ? DefaultSplitTarget(source) : DefaultPackedTarget(source);
            if (interactive)
            {
                Console.WriteLine("默认输出：" + target);
                Console.Write("直接回车使用默认路径，或输入其他路径：");
                string entered = Unquote(Console.ReadLine());
                if (!string.IsNullOrWhiteSpace(entered)) target = entered;
            }
        }
        target = Path.GetFullPath(target);
        force = ConfirmOverwriteIfNeeded(target, force, interactive);

        if (command == "unpack")
        {
            ConversionSummary summary = Unpack(source, target, force);
            PrintSuccess("已转换为 speed 拆分库", target, summary);
        }
        else if (command == "pack")
        {
            ConversionSummary summary = Pack(source, target, force);
            PrintSuccess("已转换为 master 单文件库", target, summary);
        }
        else
        {
            throw new InvalidOperationException("未知命令：" + command);
        }
        return 0;
    }

    private static void PrintBanner()
    {
        Console.WriteLine("VisualWaveDrom 波形库转换工具");
        Console.WriteLine("master 单文件库 <-> speed 拆分库");
        Console.WriteLine(new string('-', 52));
    }

    private static void PrintHelp()
    {
        Console.WriteLine("用法：");
        Console.WriteLine("  WaveLibraryConverter.exe <源路径>");
        Console.WriteLine("  WaveLibraryConverter.exe unpack <单文件库.json> [输出目录] [--force]");
        Console.WriteLine("  WaveLibraryConverter.exe pack <拆分库目录|library.json> [输出文件.json] [--force]");
        Console.WriteLine("  WaveLibraryConverter.exe verify <库文件|拆分库目录>");
        Console.WriteLine();
        Console.WriteLine("也可以双击运行，或者把 JSON 文件/拆分库目录拖到 EXE 上。");
    }

    private static void PrintSuccess(string message, string target, ConversionSummary summary)
    {
        Console.ForegroundColor = ConsoleColor.Green;
        Console.WriteLine(message);
        Console.ResetColor();
        Console.WriteLine("输出路径：" + target);
        Console.WriteLine("波形数量：" + summary.DocumentCount);
        Console.WriteLine("波形库 ID：" + summary.LibraryId);
    }

    private static bool IsHelp(string value)
    {
        return value == "-h" || value == "--help" || value == "/?" || value.Equals("help", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsCommand(string value)
    {
        return value.Equals("auto", StringComparison.OrdinalIgnoreCase)
            || value.Equals("unpack", StringComparison.OrdinalIgnoreCase)
            || value.Equals("pack", StringComparison.OrdinalIgnoreCase)
            || value.Equals("verify", StringComparison.OrdinalIgnoreCase);
    }

    private static bool PathExists(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return false;
        return File.Exists(value) || Directory.Exists(value);
    }

    private static string Unquote(string value)
    {
        if (value == null) return null;
        value = value.Trim();
        if (value.Length >= 2 && value[0] == '"' && value[value.Length - 1] == '"')
            value = value.Substring(1, value.Length - 2);
        return value;
    }

    private static string DetectCommand(string source)
    {
        if (Directory.Exists(source)) return "pack";
        if (!File.Exists(source)) throw new FileNotFoundException("找不到源路径", source);
        Dictionary<string, object> root = ReadJsonObject(source);
        string kind = GetString(root, "kind");
        if (kind == MonolithicKind) return "unpack";
        if (kind == SplitKind) return "pack";
        throw new InvalidDataException("无法识别波形库格式，kind=" + (kind ?? "<空>"));
    }

    private static string DefaultSplitTarget(string source)
    {
        string full = Path.GetFullPath(source);
        string directory = Path.GetDirectoryName(full);
        string name = Path.GetFileNameWithoutExtension(full);
        return Path.Combine(directory, name + "-speed");
    }

    private static string DefaultPackedTarget(string source)
    {
        string full = Path.GetFullPath(source);
        string directory;
        string name;
        if (Directory.Exists(full))
        {
            directory = Path.GetDirectoryName(full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            name = new DirectoryInfo(full).Name;
        }
        else
        {
            DirectoryInfo parent = Directory.GetParent(Path.GetDirectoryName(full));
            directory = parent == null ? Path.GetDirectoryName(full) : parent.FullName;
            name = new DirectoryInfo(Path.GetDirectoryName(full)).Name;
        }
        return Path.Combine(directory, name + "-master.json");
    }

    private static bool ConfirmOverwriteIfNeeded(string target, bool force, bool interactive)
    {
        bool exists = File.Exists(target) || Directory.Exists(target);
        if (!exists) return force;
        if (force) return true;
        if (!interactive) throw new IOException("输出路径已存在；确认覆盖时请添加 --force：" + target);
        Console.ForegroundColor = ConsoleColor.Yellow;
        Console.WriteLine("输出路径已经存在：" + target);
        Console.ResetColor();
        Console.Write("输入 YES 覆盖：");
        if (!string.Equals(Console.ReadLine(), "YES", StringComparison.Ordinal))
            throw new OperationCanceledException("用户取消转换");
        return true;
    }

    private static ConversionSummary Unpack(string sourceFile, string targetDirectory, bool force)
    {
        if (!File.Exists(sourceFile)) throw new FileNotFoundException("找不到 master 单文件库", sourceFile);
        Dictionary<string, object> source = ReadJsonObject(sourceFile);
        RequireKind(source, MonolithicKind);
        List<object> sourceDocuments = GetList(source, "documents", true);
        string libraryId = EnsureLibraryId(source);
        int sourceVersion = GetInt(source, "version", 2);

        List<SplitDocument> prepared = new List<SplitDocument>();
        HashSet<string> names = new HashSet<string>(StringComparer.Ordinal);
        foreach (object item in sourceDocuments)
        {
            Dictionary<string, object> document = AsObject(item, "documents 中存在非对象项目");
            string name = GetString(document, "name");
            if (string.IsNullOrWhiteSpace(name)) throw new InvalidDataException("波形缺少 name");
            if (!names.Add(name)) throw new InvalidDataException("波形 name 重复：" + name);
            string content = GetString(document, "content") ?? GetString(document, "json");
            if (content == null) throw new InvalidDataException("波形缺少 content：" + name);
            Dictionary<string, object> wave = ParseWaveContent(content, name);
            string relativeFile = "documents/" + StableDocumentFileName(name);
            Dictionary<string, object> metadata = CloneObject(document, "content", "json");
            metadata["file"] = relativeFile;
            metadata["contentLength"] = content.Length;
            metadata["titleCache"] = ExtractWaveTitle(wave, name);
            metadata["descriptionCache"] = GetString(wave, "description") ?? "";
            prepared.Add(new SplitDocument(metadata, wave, relativeFile));
        }

        Dictionary<string, object> manifest = CloneObject(source, "documents");
        manifest["kind"] = SplitKind;
        manifest["version"] = 3;
        manifest["storage"] = "split-v1";
        manifest["sourceLibraryVersion"] = sourceVersion;
        manifest["libraryId"] = libraryId;
        manifest["updatedAt"] = DateTime.UtcNow.ToString("o");
        List<object> manifestDocuments = new List<object>();
        foreach (SplitDocument item in prepared) manifestDocuments.Add(item.Metadata);
        manifest["documents"] = manifestDocuments;

        string tempDirectory = targetDirectory + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            Directory.CreateDirectory(Path.Combine(tempDirectory, "documents"));
            foreach (SplitDocument item in prepared)
            {
                string filePath = SafeRelativePath(tempDirectory, item.RelativeFile);
                WriteJsonFile(filePath, item.Wave);
            }
            WriteJsonFile(Path.Combine(tempDirectory, ManifestFileName), manifest);
            ReplaceDirectory(tempDirectory, targetDirectory, force);
        }
        catch
        {
            TryDeleteDirectory(tempDirectory);
            throw;
        }
        return new ConversionSummary(prepared.Count, libraryId);
    }

    private static ConversionSummary Pack(string sourcePath, string targetFile, bool force)
    {
        string manifestPath = ResolveManifestPath(sourcePath);
        Dictionary<string, object> manifest = ReadJsonObject(manifestPath);
        RequireKind(manifest, SplitKind);
        string rootDirectory = Path.GetDirectoryName(manifestPath);
        List<object> manifestDocuments = GetList(manifest, "documents", true);
        string libraryId = EnsureLibraryId(manifest);
        int outputVersion = GetInt(manifest, "sourceLibraryVersion", 2);
        if (outputVersion < 1 || outputVersion > 2) outputVersion = 2;

        List<object> packedDocuments = new List<object>();
        HashSet<string> names = new HashSet<string>(StringComparer.Ordinal);
        foreach (object item in manifestDocuments)
        {
            Dictionary<string, object> metadata = AsObject(item, "manifest documents 中存在非对象项目");
            string name = GetString(metadata, "name");
            string relativeFile = GetString(metadata, "file");
            if (string.IsNullOrWhiteSpace(name)) throw new InvalidDataException("拆分波形缺少 name");
            if (!names.Add(name)) throw new InvalidDataException("拆分波形 name 重复：" + name);
            if (string.IsNullOrWhiteSpace(relativeFile)) throw new InvalidDataException("拆分波形缺少 file：" + name);
            string documentPath = SafeRelativePath(rootDirectory, relativeFile);
            if (!File.Exists(documentPath)) throw new FileNotFoundException("找不到波形文件：" + relativeFile, documentPath);
            string content = File.ReadAllText(documentPath, Encoding.UTF8).TrimEnd('\r', '\n');
            ParseWaveContent(content, name);
            Dictionary<string, object> packed = CloneObject(metadata,
                "file", "contentLength", "titleCache", "descriptionCache");
            packed["content"] = PrettyJson(content);
            packedDocuments.Add(packed);
        }

        Dictionary<string, object> library = CloneObject(manifest,
            "documents", "storage", "sourceLibraryVersion");
        library["kind"] = MonolithicKind;
        library["version"] = outputVersion;
        library["libraryId"] = libraryId;
        library["updatedAt"] = DateTime.UtcNow.ToString("o");
        library["documents"] = packedDocuments;
        WriteJsonFileAtomically(targetFile, library, force);
        return new ConversionSummary(packedDocuments.Count, libraryId);
    }

    private static void Verify(string source)
    {
        string command = DetectCommand(source);
        if (command == "unpack")
        {
            Dictionary<string, object> library = ReadJsonObject(source);
            RequireKind(library, MonolithicKind);
            List<object> documents = GetList(library, "documents", true);
            foreach (object item in documents)
            {
                Dictionary<string, object> document = AsObject(item, "documents 中存在非对象项目");
                string name = GetString(document, "name") ?? "<未命名>";
                string content = GetString(document, "content") ?? GetString(document, "json");
                if (content == null) throw new InvalidDataException("波形缺少 content：" + name);
                ParseWaveContent(content, name);
            }
            Console.WriteLine("格式：master 单文件库");
            Console.WriteLine("波形数量：" + documents.Count);
            Console.WriteLine("校验通过");
            return;
        }

        string manifestPath = ResolveManifestPath(source);
        Dictionary<string, object> manifest = ReadJsonObject(manifestPath);
        RequireKind(manifest, SplitKind);
        List<object> splitDocuments = GetList(manifest, "documents", true);
        string rootDirectory = Path.GetDirectoryName(manifestPath);
        foreach (object item in splitDocuments)
        {
            Dictionary<string, object> metadata = AsObject(item, "manifest documents 中存在非对象项目");
            string name = GetString(metadata, "name") ?? "<未命名>";
            string relativeFile = GetString(metadata, "file");
            if (string.IsNullOrWhiteSpace(relativeFile)) throw new InvalidDataException("波形缺少 file：" + name);
            string filePath = SafeRelativePath(rootDirectory, relativeFile);
            if (!File.Exists(filePath)) throw new FileNotFoundException("找不到波形文件：" + relativeFile, filePath);
            ParseWaveContent(File.ReadAllText(filePath, Encoding.UTF8), name);
        }
        Console.WriteLine("格式：speed 拆分库");
        Console.WriteLine("波形数量：" + splitDocuments.Count);
        Console.WriteLine("校验通过");
    }

    private static string ResolveManifestPath(string source)
    {
        string path = Path.GetFullPath(source);
        if (Directory.Exists(path)) path = Path.Combine(path, ManifestFileName);
        if (!File.Exists(path)) throw new FileNotFoundException("找不到拆分库清单 library.json", path);
        return path;
    }

    private static Dictionary<string, object> ReadJsonObject(string filePath)
    {
        string json = File.ReadAllText(filePath, Encoding.UTF8);
        return ParseObject(json, "JSON 根节点必须是对象：" + filePath);
    }

    private static Dictionary<string, object> ParseWaveContent(string content, string name)
    {
        try
        {
            return ParseObject(content, "波形 JSON 根节点必须是对象：" + name);
        }
        catch (Exception error)
        {
            throw new InvalidDataException("波形 JSON 无效：" + name + "；" + error.Message, error);
        }
    }

    private static Dictionary<string, object> ParseObject(string json, string message)
    {
        JavaScriptSerializer serializer = CreateSerializer();
        object value = serializer.DeserializeObject(json);
        Dictionary<string, object> result = value as Dictionary<string, object>;
        if (result == null) throw new InvalidDataException(message);
        return result;
    }

    private static JavaScriptSerializer CreateSerializer()
    {
        JavaScriptSerializer serializer = new JavaScriptSerializer();
        serializer.MaxJsonLength = int.MaxValue;
        serializer.RecursionLimit = 1024;
        return serializer;
    }

    private static void WriteJsonFile(string filePath, Dictionary<string, object> value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(filePath));
        string compact = CreateSerializer().Serialize(value);
        File.WriteAllText(filePath, PrettyJson(compact) + Environment.NewLine, Utf8NoBom);
    }

    private static void WriteJsonFileAtomically(string targetFile, Dictionary<string, object> value, bool force)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(targetFile));
        string temp = targetFile + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            WriteJsonFile(temp, value);
            if (File.Exists(targetFile))
            {
                if (!force) throw new IOException("输出文件已存在：" + targetFile);
                File.Replace(temp, targetFile, null);
            }
            else
            {
                File.Move(temp, targetFile);
            }
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }

    private static void ReplaceDirectory(string tempDirectory, string targetDirectory, bool force)
    {
        if (!Directory.Exists(targetDirectory))
        {
            Directory.Move(tempDirectory, targetDirectory);
            return;
        }
        if (!force) throw new IOException("输出目录已存在：" + targetDirectory);
        string backup = targetDirectory + ".backup-" + Guid.NewGuid().ToString("N");
        Directory.Move(targetDirectory, backup);
        try
        {
            Directory.Move(tempDirectory, targetDirectory);
            TryDeleteDirectory(backup);
        }
        catch
        {
            if (!Directory.Exists(targetDirectory) && Directory.Exists(backup)) Directory.Move(backup, targetDirectory);
            throw;
        }
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path)) Directory.Delete(path, true);
        }
        catch { }
    }

    private static string SafeRelativePath(string rootDirectory, string relativePath)
    {
        if (Path.IsPathRooted(relativePath)) throw new InvalidDataException("波形文件必须使用相对路径：" + relativePath);
        string root = Path.GetFullPath(rootDirectory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string candidate = Path.GetFullPath(Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar)));
        if (!candidate.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("波形文件路径越界：" + relativePath);
        return candidate;
    }

    private static string StableDocumentFileName(string name)
    {
        StringBuilder slug = new StringBuilder();
        char[] invalid = Path.GetInvalidFileNameChars();
        foreach (char ch in name)
        {
            bool bad = ch < 32 || Array.IndexOf(invalid, ch) >= 0;
            slug.Append(bad || char.IsWhiteSpace(ch) ? '-' : ch);
            if (slug.Length >= 48) break;
        }
        string clean = slug.ToString().Trim('-', '.');
        if (clean.Length == 0) clean = "wave";
        byte[] hash;
        using (SHA256 sha = SHA256.Create()) hash = sha.ComputeHash(Encoding.UTF8.GetBytes(name));
        StringBuilder suffix = new StringBuilder();
        for (int i = 0; i < 5; i++) suffix.Append(hash[i].ToString("x2"));
        return clean + "-" + suffix + ".json";
    }

    private static string ExtractWaveTitle(Dictionary<string, object> wave, string fallback)
    {
        string title = GetString(wave, "title");
        if (!string.IsNullOrWhiteSpace(title)) return title.Trim();
        object rawHead;
        if (wave.TryGetValue("head", out rawHead))
        {
            Dictionary<string, object> head = rawHead as Dictionary<string, object>;
            if (head != null)
            {
                string text = GetString(head, "text");
                if (!string.IsNullOrWhiteSpace(text)) return text.Trim();
            }
        }
        return fallback;
    }

    private static string EnsureLibraryId(Dictionary<string, object> root)
    {
        string id = GetString(root, "libraryId");
        if (string.IsNullOrWhiteSpace(id)) id = "library-" + Guid.NewGuid().ToString("D");
        return id;
    }

    private static void RequireKind(Dictionary<string, object> root, string expected)
    {
        string kind = GetString(root, "kind");
        if (kind != expected) throw new InvalidDataException("波形库 kind 应为 " + expected + "，实际为 " + (kind ?? "<空>"));
    }

    private static Dictionary<string, object> AsObject(object value, string message)
    {
        Dictionary<string, object> result = value as Dictionary<string, object>;
        if (result == null) throw new InvalidDataException(message);
        return result;
    }

    private static string GetString(Dictionary<string, object> value, string key)
    {
        object raw;
        if (!value.TryGetValue(key, out raw) || raw == null) return null;
        return raw as string ?? Convert.ToString(raw, System.Globalization.CultureInfo.InvariantCulture);
    }

    private static int GetInt(Dictionary<string, object> value, string key, int fallback)
    {
        object raw;
        if (!value.TryGetValue(key, out raw) || raw == null) return fallback;
        int result;
        return int.TryParse(Convert.ToString(raw, System.Globalization.CultureInfo.InvariantCulture), out result) ? result : fallback;
    }

    private static List<object> GetList(Dictionary<string, object> value, string key, bool required)
    {
        object raw;
        if (!value.TryGetValue(key, out raw) || raw == null)
        {
            if (required) throw new InvalidDataException("缺少数组字段：" + key);
            return new List<object>();
        }
        object[] array = raw as object[];
        if (array != null) return new List<object>(array);
        ArrayList arrayList = raw as ArrayList;
        if (arrayList != null) return new List<object>(arrayList.ToArray());
        List<object> list = raw as List<object>;
        if (list != null) return list;
        throw new InvalidDataException("字段不是数组：" + key);
    }

    private static Dictionary<string, object> CloneObject(Dictionary<string, object> source, params string[] excluded)
    {
        HashSet<string> skip = new HashSet<string>(excluded, StringComparer.Ordinal);
        Dictionary<string, object> clone = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (KeyValuePair<string, object> pair in source)
        {
            if (!skip.Contains(pair.Key)) clone[pair.Key] = pair.Value;
        }
        return clone;
    }

    private static string PrettyJson(string compactJson)
    {
        StringBuilder output = new StringBuilder(compactJson.Length + compactJson.Length / 4);
        int indent = 0;
        bool inString = false;
        bool escaped = false;
        for (int i = 0; i < compactJson.Length; i++)
        {
            char ch = compactJson[i];
            if (inString)
            {
                output.Append(ch);
                if (escaped) escaped = false;
                else if (ch == '\\') escaped = true;
                else if (ch == '"') inString = false;
                continue;
            }
            if (ch == '"')
            {
                inString = true;
                output.Append(ch);
            }
            else if (ch == '{' || ch == '[')
            {
                output.Append(ch);
                output.AppendLine();
                indent++;
                AppendIndent(output, indent);
            }
            else if (ch == '}' || ch == ']')
            {
                output.AppendLine();
                indent--;
                AppendIndent(output, indent);
                output.Append(ch);
            }
            else if (ch == ',')
            {
                output.Append(ch);
                output.AppendLine();
                AppendIndent(output, indent);
            }
            else if (ch == ':')
            {
                output.Append(": ");
            }
            else if (!char.IsWhiteSpace(ch))
            {
                output.Append(ch);
            }
        }
        return output.ToString();
    }

    private static void AppendIndent(StringBuilder output, int indent)
    {
        if (indent > 0) output.Append(' ', indent * 2);
    }

    private sealed class SplitDocument
    {
        internal readonly Dictionary<string, object> Metadata;
        internal readonly Dictionary<string, object> Wave;
        internal readonly string RelativeFile;

        internal SplitDocument(Dictionary<string, object> metadata, Dictionary<string, object> wave, string relativeFile)
        {
            Metadata = metadata;
            Wave = wave;
            RelativeFile = relativeFile;
        }
    }

    private sealed class ConversionSummary
    {
        internal readonly int DocumentCount;
        internal readonly string LibraryId;

        internal ConversionSummary(int documentCount, string libraryId)
        {
            DocumentCount = documentCount;
            LibraryId = libraryId;
        }
    }
}
