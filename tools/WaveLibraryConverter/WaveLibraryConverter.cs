using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

internal static class WaveLibraryConverter
{
    private const string MonolithicKind = "VisualWaveDromWaveLibrary";
    private const string SplitKind = "VisualWaveDromSplitWaveLibrary";
    private const string ManifestFileName = "library.json";
    private const string DatabaseFileName = "library.sqlite";
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
            if (command == "sqlite") command = "to-sqlite";
            if (command == "json") command = "to-json";
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
            Console.Write("请输入或拖入 SQLite/JSON 波形库或旧拆分库目录：");
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
            if (command == "to-sqlite") target = DefaultSqliteTarget(source);
            else if (command == "to-json") target = DefaultJsonTarget(source);
            else target = command == "unpack" ? DefaultSplitTarget(source) : DefaultPackedTarget(source);
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

        if (command == "to-sqlite")
        {
            ConversionSummary summary = ToSqlite(source, target, force);
            PrintSuccess("已转换为 SQLite 波形库", target, summary);
        }
        else if (command == "to-json")
        {
            ConversionSummary summary = FromSqlite(source, target, force);
            PrintSuccess("已导出为完整 JSON 波形库", target, summary);
        }
        else if (command == "unpack")
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
        Console.WriteLine("SQLite <-> 完整 JSON，并兼容旧拆分 JSON");
        Console.WriteLine(new string('-', 52));
    }

    private static void PrintHelp()
    {
        Console.WriteLine("用法：");
        Console.WriteLine("  WaveLibraryConverter.exe <源路径>");
        Console.WriteLine("  WaveLibraryConverter.exe to-sqlite <完整库.json|旧拆分库> [输出.sqlite] [--force]");
        Console.WriteLine("  WaveLibraryConverter.exe to-json <波形库.sqlite> [输出.json] [--force]");
        Console.WriteLine("  WaveLibraryConverter.exe unpack <单文件库.json> [输出目录] [--force]");
        Console.WriteLine("  WaveLibraryConverter.exe pack <拆分库目录|library.json> [输出文件.json] [--force]");
        Console.WriteLine("  WaveLibraryConverter.exe verify <库文件|拆分库目录>");
        Console.WriteLine();
        Console.WriteLine("也可以双击运行，或把 SQLite、JSON 文件、旧拆分库目录拖到 EXE 上。");
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
            || value.Equals("to-sqlite", StringComparison.OrdinalIgnoreCase)
            || value.Equals("sqlite", StringComparison.OrdinalIgnoreCase)
            || value.Equals("to-json", StringComparison.OrdinalIgnoreCase)
            || value.Equals("json", StringComparison.OrdinalIgnoreCase)
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
        if (Directory.Exists(source))
        {
            string sqlite = Path.Combine(source, DatabaseFileName);
            if (File.Exists(sqlite) && IsSqliteFile(sqlite)) return "to-json";
            return "to-sqlite";
        }
        if (!File.Exists(source)) throw new FileNotFoundException("找不到源路径", source);
        if (IsSqliteFile(source)) return "to-json";
        Dictionary<string, object> root = ReadJsonObject(source);
        string kind = GetString(root, "kind");
        if (kind == MonolithicKind || kind == SplitKind) return "to-sqlite";
        throw new InvalidDataException("无法识别波形库格式，kind=" + (kind ?? "<空>"));
    }

    private static string DefaultSqliteTarget(string source)
    {
        string full = Path.GetFullPath(source);
        if (Directory.Exists(full)) return Path.Combine(full, DatabaseFileName);
        string directory = Path.GetDirectoryName(full);
        string name = Path.GetFileNameWithoutExtension(full);
        if (string.Equals(Path.GetFileName(full), ManifestFileName, StringComparison.OrdinalIgnoreCase))
            return Path.Combine(directory, DatabaseFileName);
        return Path.Combine(directory, name, DatabaseFileName);
    }

    private static string DefaultJsonTarget(string source)
    {
        string full = Path.GetFullPath(source);
        if (Directory.Exists(full)) full = Path.Combine(full, DatabaseFileName);
        string directory = Path.GetDirectoryName(full);
        string parentName = new DirectoryInfo(directory).Name;
        string outputDirectory = Directory.GetParent(directory) == null
            ? directory
            : Directory.GetParent(directory).FullName;
        return Path.Combine(outputDirectory, parentName + "-export.json");
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

    private static ConversionSummary ToSqlite(string sourcePath, string targetFile, bool force)
    {
        Dictionary<string, object> library = LoadJsonLibrary(sourcePath);
        ConversionSummary summary = ValidateLibrary(library);
        string tempFile = targetFile + ".tmp-" + Guid.NewGuid().ToString("N");
        Directory.CreateDirectory(Path.GetDirectoryName(targetFile));
        try
        {
            WriteSqliteLibrary(tempFile, library);
            ReadSqliteLibrary(tempFile);
            if (File.Exists(targetFile))
            {
                if (!force) throw new IOException("输出文件已存在：" + targetFile);
                File.Replace(tempFile, targetFile, null);
            }
            else
            {
                File.Move(tempFile, targetFile);
            }
        }
        finally
        {
            if (File.Exists(tempFile)) File.Delete(tempFile);
            if (File.Exists(tempFile + "-wal")) File.Delete(tempFile + "-wal");
            if (File.Exists(tempFile + "-shm")) File.Delete(tempFile + "-shm");
        }
        return summary;
    }

    private static ConversionSummary FromSqlite(string sourcePath, string targetFile, bool force)
    {
        Dictionary<string, object> library = ReadSqliteLibrary(sourcePath);
        ConversionSummary summary = ValidateLibrary(library);
        WriteJsonFileAtomically(targetFile, library, force);
        return summary;
    }

    private static Dictionary<string, object> LoadJsonLibrary(string sourcePath)
    {
        string full = Path.GetFullPath(sourcePath);
        string manifestPath = Directory.Exists(full) ? Path.Combine(full, ManifestFileName) : full;
        if (!File.Exists(manifestPath)) throw new FileNotFoundException("找不到源波形库", manifestPath);
        Dictionary<string, object> root = ReadJsonObject(manifestPath);
        string kind = GetString(root, "kind");
        if (kind == MonolithicKind) return root;
        if (kind != SplitKind) throw new InvalidDataException("无法识别 JSON 波形库格式");
        return PackSplitLibrary(manifestPath, root);
    }

    private static Dictionary<string, object> PackSplitLibrary(string manifestPath, Dictionary<string, object> manifest)
    {
        string rootDirectory = Path.GetDirectoryName(manifestPath);
        List<object> manifestDocuments = GetList(manifest, "documents", true);
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
        library["version"] = GetInt(manifest, "sourceLibraryVersion", 2);
        library["libraryId"] = EnsureLibraryId(manifest);
        library["updatedAt"] = DateTime.UtcNow.ToString("o");
        library["documents"] = packedDocuments;
        return library;
    }

    private static ConversionSummary ValidateLibrary(Dictionary<string, object> library)
    {
        RequireKind(library, MonolithicKind);
        string libraryId = EnsureLibraryId(library);
        library["libraryId"] = libraryId;
        library["version"] = Math.Max(2, GetInt(library, "version", 2));
        List<object> documents = GetList(library, "documents", true);
        HashSet<string> names = new HashSet<string>(StringComparer.Ordinal);
        foreach (object item in documents)
        {
            Dictionary<string, object> document = AsObject(item, "documents 中存在非对象项目");
            string name = GetString(document, "name");
            if (string.IsNullOrWhiteSpace(name)) throw new InvalidDataException("波形缺少 name");
            if (!names.Add(name)) throw new InvalidDataException("波形 name 重复：" + name);
            string content = GetString(document, "content") ?? GetString(document, "json");
            if (content == null) throw new InvalidDataException("波形缺少 content：" + name);
            ParseWaveContent(content, name);
        }
        return new ConversionSummary(documents.Count, libraryId);
    }

    private static void WriteSqliteLibrary(string targetFile, Dictionary<string, object> library)
    {
        JavaScriptSerializer serializer = CreateSerializer();
        List<object> documents = GetList(library, "documents", true);
        string libraryId = EnsureLibraryId(library);
        string updatedAt = GetString(library, "updatedAt") ?? DateTime.UtcNow.ToString("o");
        object directories = GetValue(library, "directories") ?? new object[0];
        object rootDocuments = GetValue(library, "rootDocuments") ?? new object[0];
        string activeDocumentName = GetString(library, "activeDocumentName") ?? "";
        string selectedDirectoryId = GetString(library, "selectedDirectoryId") ?? "nav-root";

        StringBuilder sql = new StringBuilder();
        sql.AppendLine("PRAGMA journal_mode=DELETE;");
        sql.AppendLine("PRAGMA synchronous=FULL;");
        sql.AppendLine("CREATE TABLE vwd_library (singleton INTEGER PRIMARY KEY CHECK(singleton=1), kind TEXT NOT NULL, version INTEGER NOT NULL, library_id TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL, directories_json TEXT NOT NULL DEFAULT '[]', root_documents_json TEXT NOT NULL DEFAULT '[]', active_document_name TEXT NOT NULL DEFAULT '', selected_directory_id TEXT NOT NULL DEFAULT 'nav-root');");
        sql.AppendLine("CREATE TABLE vwd_documents (name TEXT PRIMARY KEY, sort_order INTEGER NOT NULL, content TEXT NOT NULL, hscale REAL NOT NULL DEFAULT 1, wave_edit_mode TEXT NOT NULL DEFAULT 'modify', revision INTEGER NOT NULL DEFAULT 0, saved_at TEXT NOT NULL DEFAULT '', title_cache TEXT NOT NULL DEFAULT '', description_cache TEXT NOT NULL DEFAULT '', content_length INTEGER NOT NULL DEFAULT 0, extra_json TEXT NOT NULL DEFAULT '{}');");
        sql.AppendLine("CREATE INDEX vwd_documents_sort_order ON vwd_documents(sort_order, name);");
        sql.AppendLine("PRAGMA user_version=1;");
        sql.AppendLine("BEGIN IMMEDIATE;");
        sql.Append("INSERT INTO vwd_library VALUES(1,").Append(SqlText(MonolithicKind)).Append(',')
            .Append(Math.Max(2, GetInt(library, "version", 2))).Append(',')
            .Append(SqlText(libraryId)).Append(',').Append(SqlText(updatedAt)).Append(',')
            .Append(SqlText(serializer.Serialize(directories))).Append(',')
            .Append(SqlText(serializer.Serialize(rootDocuments))).Append(',')
            .Append(SqlText(activeDocumentName)).Append(',').Append(SqlText(selectedDirectoryId)).AppendLine(");");

        for (int index = 0; index < documents.Count; index++)
        {
            Dictionary<string, object> document = AsObject(documents[index], "documents 中存在非对象项目");
            string name = GetString(document, "name");
            string content = GetString(document, "content") ?? GetString(document, "json");
            Dictionary<string, object> wave = ParseWaveContent(content, name);
            Dictionary<string, object> extra = CloneObject(document,
                "name", "content", "json", "hscale", "waveEditMode", "revision", "savedAt",
                "deferred", "titleCache", "descriptionCache", "contentLength", "sortOrder");
            string waveEditMode = GetString(document, "waveEditMode") == "insert" ? "insert" : "modify";
            string savedAt = GetString(document, "savedAt") ?? "";
            string titleCache = ExtractWaveTitle(wave, name);
            string descriptionCache = GetString(wave, "description") ?? "";
            sql.Append("INSERT INTO vwd_documents VALUES(")
                .Append(SqlText(name)).Append(',').Append(index).Append(',').Append(SqlText(content)).Append(',')
                .Append(GetDouble(document, "hscale", 1).ToString(CultureInfo.InvariantCulture)).Append(',')
                .Append(SqlText(waveEditMode)).Append(',').Append(Math.Max(0, GetInt(document, "revision", 0))).Append(',')
                .Append(SqlText(savedAt)).Append(',').Append(SqlText(titleCache)).Append(',')
                .Append(SqlText(descriptionCache)).Append(',').Append(content.Length).Append(',')
                .Append(SqlText(serializer.Serialize(extra))).AppendLine(");");
        }
        sql.AppendLine("COMMIT;");
        RunSqlite(targetFile, sql.ToString(), false);
    }

    private static Dictionary<string, object> ReadSqliteLibrary(string sourcePath)
    {
        string databasePath = ResolveSqlitePath(sourcePath);
        if (!IsSqliteFile(databasePath)) throw new InvalidDataException("所选文件不是 SQLite 数据库：" + databasePath);
        List<Dictionary<string, object>> metaRows = QuerySqlite(databasePath,
            "SELECT hex(kind) kind_hex, version, hex(library_id) library_id_hex, hex(updated_at) updated_at_hex, hex(directories_json) directories_hex, hex(root_documents_json) root_documents_hex, hex(active_document_name) active_document_hex, hex(selected_directory_id) selected_directory_hex FROM vwd_library WHERE singleton=1 LIMIT 1;");
        if (metaRows.Count == 0 || HexToString(GetString(metaRows[0], "kind_hex")) != MonolithicKind)
            throw new InvalidDataException("不是有效的 VisualWaveDrom SQLite 波形库");
        Dictionary<string, object> meta = metaRows[0];
        Dictionary<string, object> library = new Dictionary<string, object>(StringComparer.Ordinal);
        library["kind"] = MonolithicKind;
        library["version"] = GetInt(meta, "version", 2);
        library["libraryId"] = HexToString(GetString(meta, "library_id_hex"));
        library["updatedAt"] = HexToString(GetString(meta, "updated_at_hex"));
        library["directories"] = ParseJsonValue(HexToString(GetString(meta, "directories_hex")), new object[0]);
        library["rootDocuments"] = ParseJsonValue(HexToString(GetString(meta, "root_documents_hex")), new object[0]);
        library["activeDocumentName"] = HexToString(GetString(meta, "active_document_hex"));
        library["selectedDirectoryId"] = HexToString(GetString(meta, "selected_directory_hex"));

        List<Dictionary<string, object>> rows = QuerySqlite(databasePath,
            "SELECT hex(name) name_hex, hex(content) content_hex, hscale, hex(wave_edit_mode) wave_edit_mode_hex, revision, hex(saved_at) saved_at_hex, hex(extra_json) extra_hex FROM vwd_documents ORDER BY sort_order, name;");
        List<object> documents = new List<object>();
        foreach (Dictionary<string, object> row in rows)
        {
            string extraJson = HexToString(GetString(row, "extra_hex"));
            Dictionary<string, object> document = ParseJsonValue(extraJson, new Dictionary<string, object>()) as Dictionary<string, object>
                ?? new Dictionary<string, object>(StringComparer.Ordinal);
            string name = HexToString(GetString(row, "name_hex"));
            string content = HexToString(GetString(row, "content_hex"));
            document["name"] = name;
            document["content"] = content;
            document["hscale"] = GetValue(row, "hscale") ?? 1;
            document["waveEditMode"] = HexToString(GetString(row, "wave_edit_mode_hex"));
            document["revision"] = GetInt(row, "revision", 0);
            document["savedAt"] = HexToString(GetString(row, "saved_at_hex"));
            ParseWaveContent(content, name);
            documents.Add(document);
        }
        library["documents"] = documents;
        return library;
    }

    private static string ResolveSqlitePath(string sourcePath)
    {
        string full = Path.GetFullPath(sourcePath);
        if (Directory.Exists(full)) full = Path.Combine(full, DatabaseFileName);
        if (!File.Exists(full)) throw new FileNotFoundException("找不到 SQLite 波形库", full);
        return full;
    }

    private static bool IsSqliteFile(string filePath)
    {
        if (!File.Exists(filePath)) return false;
        byte[] expected = Encoding.ASCII.GetBytes("SQLite format 3\0");
        byte[] actual = new byte[expected.Length];
        using (FileStream stream = File.OpenRead(filePath))
        {
            if (stream.Read(actual, 0, actual.Length) != actual.Length) return false;
        }
        for (int index = 0; index < expected.Length; index++) if (actual[index] != expected[index]) return false;
        return true;
    }

    private static string SqliteExecutablePath()
    {
        string executable = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "inc", "sqlite", "sqlite3.exe");
        if (!File.Exists(executable)) throw new FileNotFoundException("找不到 SQLite 运行文件", executable);
        return executable;
    }

    private static string RunSqlite(string databasePath, string sql, bool jsonOutput)
    {
        ProcessStartInfo info = new ProcessStartInfo();
        info.FileName = SqliteExecutablePath();
        info.Arguments = "-batch -bail " + (jsonOutput ? "-json " : "")
            + "\"" + databasePath.Replace("\"", "\"\"") + "\"";
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardInput = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        using (Process process = Process.Start(info))
        {
            byte[] inputBytes = Utf8NoBom.GetBytes(sql);
            process.StandardInput.BaseStream.Write(inputBytes, 0, inputBytes.Length);
            process.StandardInput.BaseStream.Close();
            string output = process.StandardOutput.ReadToEnd();
            string error = process.StandardError.ReadToEnd();
            process.WaitForExit();
            if (process.ExitCode != 0) throw new InvalidOperationException("SQLite 执行失败：" + error.Trim());
            return output.Trim();
        }
    }

    private static List<Dictionary<string, object>> QuerySqlite(string databasePath, string sql)
    {
        string json = RunSqlite(databasePath, sql, true);
        List<Dictionary<string, object>> rows = new List<Dictionary<string, object>>();
        if (string.IsNullOrWhiteSpace(json)) return rows;
        object value = CreateSerializer().DeserializeObject(json);
        object[] array = value as object[];
        if (array == null) throw new InvalidDataException("SQLite 查询结果格式无效");
        foreach (object item in array) rows.Add(AsObject(item, "SQLite 查询结果包含非对象项目"));
        return rows;
    }

    private static string SqlText(string value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value ?? "");
        StringBuilder hex = new StringBuilder(bytes.Length * 2);
        foreach (byte item in bytes) hex.Append(item.ToString("x2"));
        return "CAST(X'" + hex + "' AS TEXT)";
    }

    private static string HexToString(string value)
    {
        if (string.IsNullOrEmpty(value)) return "";
        if (value.Length % 2 != 0) throw new InvalidDataException("SQLite 文本编码无效");
        byte[] bytes = new byte[value.Length / 2];
        for (int index = 0; index < bytes.Length; index++)
            bytes[index] = byte.Parse(value.Substring(index * 2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        return Encoding.UTF8.GetString(bytes);
    }

    private static object ParseJsonValue(string json, object fallback)
    {
        if (string.IsNullOrWhiteSpace(json)) return fallback;
        try { return CreateSerializer().DeserializeObject(json); }
        catch { return fallback; }
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
        string full = Path.GetFullPath(source);
        string databasePath = Directory.Exists(full) ? Path.Combine(full, DatabaseFileName) : full;
        bool sqlite = File.Exists(databasePath) && IsSqliteFile(databasePath);
        Dictionary<string, object> library = sqlite
            ? ReadSqliteLibrary(databasePath)
            : LoadJsonLibrary(full);
        ConversionSummary summary = ValidateLibrary(library);
        Console.WriteLine("格式：" + (sqlite ? "SQLite 波形库" : "兼容 JSON 波形库"));
        Console.WriteLine("波形数量：" + summary.DocumentCount);
        Console.WriteLine("波形库 ID：" + summary.LibraryId);
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

    private static object GetValue(Dictionary<string, object> value, string key)
    {
        object raw;
        return value.TryGetValue(key, out raw) ? raw : null;
    }

    private static int GetInt(Dictionary<string, object> value, string key, int fallback)
    {
        object raw;
        if (!value.TryGetValue(key, out raw) || raw == null) return fallback;
        int result;
        return int.TryParse(Convert.ToString(raw, System.Globalization.CultureInfo.InvariantCulture), out result) ? result : fallback;
    }

    private static double GetDouble(Dictionary<string, object> value, string key, double fallback)
    {
        object raw;
        if (!value.TryGetValue(key, out raw) || raw == null) return fallback;
        double result;
        return double.TryParse(Convert.ToString(raw, CultureInfo.InvariantCulture), NumberStyles.Float,
            CultureInfo.InvariantCulture, out result) ? result : fallback;
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
