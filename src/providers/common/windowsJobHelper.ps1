# Broker-owned Windows x64 job-object launch helper (PowerShell 5.1).
# Unverified partial source repaired for the Windows managed-execution package —
# not claimed production-ready; validate via offline fake Node child tests.
#
# Protocol with src/providers/common/windowsJob.ts:
#   stdin  : one bounded JSON config line, then "<nonce> resume" /
#            "<nonce> cancel". PRIVATE — nonce never reaches native args/env/stdin.
#   stdout : ONLY nonce-authenticated control lines:
#              "<nonce> <op> {json}"
#            Native stdout/stderr travel as bounded base64 chunks (stdout_chunk /
#            stderr_chunk) so native NDJSON cannot forge receipts and UTF-8 is
#            never split at the protocol boundary.
#   stderr : helper diagnostics only (never treated as receipts).
#
# Ownership: CreateProcessW(CREATE_SUSPENDED|…) with explicit inheritable-handle
# whitelist → AssignProcessToJobObject(KILL_ON_JOB_CLOSE) → wrapper ResumeThread
# after durable ownership persistence. Quiescence = ActiveProcesses==0 AND both
# native pipes drained. Termination = TerminateJobObject on the owned handle
# only. Owner bind is exact HANDLE + creation-time (no empty-time adopt).

$ErrorActionPreference = 'Stop'

$nativeSource = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.Text;
using System.Threading;

public class BrokerJobConfig
{
    public string Nonce;
    public string LaunchUuid;
    public string JobName;
    public string VerbatimCommandLine;
    public string ApplicationName;
    public string[] Args;
    public string Cwd;
    public string[] EnvPairs;
    public byte[] ChildStdin;
    public int OwnerPid;
    public string OwnerCreationTime;
    public int ResumeTimeoutMs;
    public int TerminateQuiesceMs;
    /** Combined native stdout+stderr relay cap (bytes). <=0 means default 8 MiB. */
    public long MaxNativeOutputBytes;
}

[StructLayout(LayoutKind.Sequential)]
internal struct BrokerSecurityAttributes
{
    public int nLength;
    public IntPtr lpSecurityDescriptor;
    public bool bInheritHandle;
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
internal struct BrokerStartupInfo
{
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
internal struct BrokerStartupInfoEx
{
    public BrokerStartupInfo StartupInfo;
    public IntPtr lpAttributeList;
}

[StructLayout(LayoutKind.Sequential)]
internal struct BrokerProcessInformation
{
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
}

[StructLayout(LayoutKind.Sequential)]
internal struct BrokerJobAccounting
{
    public long TotalUserTime;
    public long TotalKernelTime;
    public long ThisPeriodTotalUserTime;
    public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount;
    public uint TotalProcesses;
    public uint ActiveProcesses;
    public uint TotalTerminatedProcesses;
}

[StructLayout(LayoutKind.Sequential)]
internal struct BrokerIoCounters
{
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
}

[StructLayout(LayoutKind.Sequential)]
internal struct BrokerBasicLimitInformation
{
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
}

[StructLayout(LayoutKind.Sequential)]
internal struct BrokerExtendedLimitInformation
{
    public BrokerBasicLimitInformation BasicLimitInformation;
    public BrokerIoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
}

public static class BrokerJobNative
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const int STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int JobObjectBasicAccountingInformation = 1;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint PROCESS_SYNCHRONIZE = 0x00100000;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const int PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
    private const int NATIVE_CHUNK = 4096;
    private const int NATIVE_QUEUE_CAP = 256;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, ref BrokerExtendedLimitInformation lpInfo, int cbInfo);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr hJob, int infoClass, out BrokerJobAccounting lpInfo, int cbInfo, out int lpReturnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, ref BrokerSecurityAttributes lpPipeAttributes, int nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        IntPtr lpStartupInfo,
        out BrokerProcessInformation lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr lpAttributeList, uint dwFlags, IntPtr Attribute, IntPtr lpValue,
        IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr hProcess, out long lpCreationTime, out long lpExitTime, out long lpKernelTime, out long lpUserTime);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll")]
    private static extern int GetCurrentProcessId();

    private static readonly object StdinGate = new object();
    private static Stream s_stdin;
    private static byte[] s_chunk = new byte[0];
    private static int s_chunkPos;
    private static int s_chunkLen;

    private static int ReadStdinByte()
    {
        lock (StdinGate)
        {
            if (s_stdin == null) s_stdin = Console.OpenStandardInput();
            if (s_chunkPos >= s_chunkLen)
            {
                if (s_chunk.Length == 0) s_chunk = new byte[65536];
                int n = s_stdin.Read(s_chunk, 0, s_chunk.Length);
                if (n <= 0) return -1;
                s_chunkPos = 0;
                s_chunkLen = n;
            }
            return s_chunk[s_chunkPos++];
        }
    }

    public static string ReadConfigLine(long capBytes)
    {
        MemoryStream ms = new MemoryStream();
        try
        {
            while (true)
            {
                int b = ReadStdinByte();
                if (b < 0) break;
                if (b == 10) return Encoding.UTF8.GetString(ms.ToArray());
                if (b != 13) ms.WriteByte((byte)b);
                if (ms.Length > capBytes) throw new IOException("CONFIG_LINE_TOO_LONG");
            }
            return Encoding.UTF8.GetString(ms.ToArray());
        }
        finally { ms.Dispose(); }
    }

    private static string ReadControlLine()
    {
        MemoryStream ms = new MemoryStream();
        try
        {
            while (true)
            {
                int b = ReadStdinByte();
                if (b < 0) return null;
                if (b == 10) return Encoding.UTF8.GetString(ms.ToArray());
                if (b != 13) ms.WriteByte((byte)b);
                if (ms.Length > 4096) return null;
            }
        }
        finally { ms.Dispose(); }
    }

    private static string QuoteArg(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return arg;
        StringBuilder sb = new StringBuilder(arg.Length + 8);
        sb.Append('"');
        int backslashes = 0;
        for (int i = 0; i < arg.Length; i++)
        {
            char c = arg[i];
            if (c == '\\') { backslashes++; continue; }
            if (c == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                backslashes = 0;
                sb.Append('"');
                continue;
            }
            if (backslashes > 0) { sb.Append('\\', backslashes); backslashes = 0; }
            sb.Append(c);
        }
        if (backslashes > 0) sb.Append('\\', backslashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    private static string JsonEscape(string s)
    {
        StringBuilder sb = new StringBuilder(s.Length + 8);
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (c == '"' || c == '\\') { sb.Append('\\').Append(c); continue; }
            if (c < ' ') { sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture)); continue; }
            sb.Append(c);
        }
        return sb.ToString();
    }

    private static string Win32Msg(string api, int error)
    {
        return "{\"api\":\"" + JsonEscape(api) + "\",\"win32_error\":" + error.ToString(CultureInfo.InvariantCulture) + "}";
    }

    private static byte[] BuildEnvironmentBlock(string[] pairs)
    {
        SortedDictionary<string, string> map = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < pairs.Length; i++)
        {
            string p = pairs[i];
            int eq = p.IndexOf('=');
            if (eq <= 0) continue;
            map[p.Substring(0, eq)] = p.Substring(eq + 1);
        }
        StringBuilder sb = new StringBuilder();
        foreach (KeyValuePair<string, string> kv in map) sb.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
        sb.Append('\0');
        return Encoding.Unicode.GetBytes(sb.ToString());
    }

    private sealed class RunState
    {
        public BrokerJobConfig Cfg;
        public Action<string, string> EmitControl;

        public IntPtr Job = IntPtr.Zero;
        public IntPtr Owner = IntPtr.Zero;
        public BrokerProcessInformation Root;

        public readonly BlockingCollection<byte[]> NativeOut = new BlockingCollection<byte[]>(NATIVE_QUEUE_CAP);
        public readonly BlockingCollection<byte[]> NativeErr = new BlockingCollection<byte[]>(NATIVE_QUEUE_CAP);
        public volatile bool StdinEof;
        public volatile bool ResumeRequested;
        public volatile bool CancelRequested;
        public volatile bool OutReaderDone;
        public volatile bool ErrReaderDone;

        public volatile bool Resumed;
        public volatile bool RootExited;
        public uint RootExitCode;
        public volatile string TerminationReason;
        public int LastQueryError;
        public long NativeBytesEmitted;
        public volatile bool OutputLimited;

        public uint ActiveProcesses()
        {
            BrokerJobAccounting accounting;
            int returned;
            if (!QueryInformationJobObject(Job, JobObjectBasicAccountingInformation, out accounting,
                Marshal.SizeOf(typeof(BrokerJobAccounting)), out returned))
            {
                LastQueryError = Marshal.GetLastWin32Error();
                return uint.MaxValue;
            }
            LastQueryError = 0;
            return accounting.ActiveProcesses;
        }

        public void PumpNative()
        {
            long cap = Cfg.MaxNativeOutputBytes > 0 ? Cfg.MaxNativeOutputBytes : (8L * 1024L * 1024L);
            byte[] chunk;
            while (NativeOut.TryTake(out chunk))
            {
                if (OutputLimited)
                {
                    // Drain/discard after quota — do not relay or accumulate strings.
                    continue;
                }
                NativeBytesEmitted += chunk.LongLength;
                if (NativeBytesEmitted > cap)
                {
                    OutputLimited = true;
                    CancelRequested = true;
                    if (TerminationReason == null) TerminationReason = "output_limit";
                    try { EmitControl("output_limit", "{\"reason\":\"total\"}"); } catch { }
                    continue;
                }
                EmitControl("stdout_chunk", "{\"b64\":\"" + Convert.ToBase64String(chunk) + "\"}");
            }
            while (NativeErr.TryTake(out chunk))
            {
                if (OutputLimited) continue;
                NativeBytesEmitted += chunk.LongLength;
                if (NativeBytesEmitted > cap)
                {
                    OutputLimited = true;
                    CancelRequested = true;
                    if (TerminationReason == null) TerminationReason = "output_limit";
                    try { EmitControl("output_limit", "{\"reason\":\"total\"}"); } catch { }
                    continue;
                }
                EmitControl("stderr_chunk", "{\"b64\":\"" + Convert.ToBase64String(chunk) + "\"}");
            }
        }
    }

    public static int Run(BrokerJobConfig cfg, Action<string, string> emitControl)
    {
        RunState st = new RunState();
        st.Cfg = cfg;
        st.EmitControl = emitControl;

        IntPtr outRead = IntPtr.Zero, outWrite = IntPtr.Zero;
        IntPtr inRead = IntPtr.Zero, inWrite = IntPtr.Zero;
        IntPtr errRead = IntPtr.Zero, errWrite = IntPtr.Zero;
        IntPtr envBlock = IntPtr.Zero;
        IntPtr attrList = IntPtr.Zero;
        IntPtr handleList = IntPtr.Zero;
        FileStream outStream = null, errStream = null;
        Thread outThread = null, errThread = null, controlThread = null, childStdinThread = null;
        try
        {
            // Exact owner bind: refuse non-positive PID or empty/non-positive creation-time (never adopt observed identity).
            if (cfg.OwnerPid <= 0 || string.IsNullOrEmpty(cfg.OwnerCreationTime))
            {
                emitControl("owner_open_failed", "{\"pid\":" + cfg.OwnerPid.ToString(CultureInfo.InvariantCulture) +
                    ",\"reason\":\"owner_creation_time_required\"}");
                return 2;
            }
            st.Owner = OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, cfg.OwnerPid);
            if (st.Owner == IntPtr.Zero)
            {
                emitControl("owner_open_failed", "{\"pid\":" + cfg.OwnerPid.ToString(CultureInfo.InvariantCulture) + "}");
                return 2;
            }
            long created, exited, kernel, user;
            if (!GetProcessTimes(st.Owner, out created, out exited, out kernel, out user) || created <= 0)
            {
                emitControl("owner_open_failed", "{\"pid\":" + cfg.OwnerPid.ToString(CultureInfo.InvariantCulture) + "}");
                return 2;
            }
            string observed = created.ToString(CultureInfo.InvariantCulture);
            if (cfg.OwnerCreationTime != observed)
            {
                // Stale PID reuse: refuse without TerminateJobObject / foreign kill.
                emitControl("owner_mismatch", "{\"expected\":\"" + JsonEscape(cfg.OwnerCreationTime) +
                    "\",\"observed\":\"" + observed + "\"}");
                return 2;
            }

            st.Job = CreateJobObjectW(IntPtr.Zero, cfg.JobName);
            int jobErr = Marshal.GetLastWin32Error();
            if (st.Job == IntPtr.Zero)
            {
                emitControl("launch_failed", Win32Msg("CreateJobObjectW", jobErr));
                return 3;
            }
            if (jobErr == 183 /* ERROR_ALREADY_EXISTS */)
            {
                CloseHandle(st.Job);
                st.Job = IntPtr.Zero;
                emitControl("launch_failed", Win32Msg("CreateJobObjectW_AlreadyExists", jobErr));
                return 3;
            }
            BrokerExtendedLimitInformation limits = new BrokerExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(st.Job, JobObjectExtendedLimitInformation, ref limits,
                Marshal.SizeOf(typeof(BrokerExtendedLimitInformation))))
            {
                emitControl("launch_failed", Win32Msg("SetInformationJobObject", Marshal.GetLastWin32Error()));
                return 3;
            }

            // Pipes: create with inherit=true, then clear inherit on helper ends.
            // Child inherits ONLY the three whitelisted ends via HANDLE_LIST.
            BrokerSecurityAttributes sa = new BrokerSecurityAttributes();
            sa.nLength = Marshal.SizeOf(sa);
            sa.bInheritHandle = true;
            if (!CreatePipe(out outRead, out outWrite, ref sa, 0) ||
                !CreatePipe(out errRead, out errWrite, ref sa, 0) ||
                !CreatePipe(out inRead, out inWrite, ref sa, 0))
            {
                emitControl("launch_failed", Win32Msg("CreatePipe", Marshal.GetLastWin32Error()));
                return 3;
            }
            if (!SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0) ||
                !SetHandleInformation(errRead, HANDLE_FLAG_INHERIT, 0) ||
                !SetHandleInformation(inWrite, HANDLE_FLAG_INHERIT, 0))
            {
                emitControl("launch_failed", Win32Msg("SetHandleInformation", Marshal.GetLastWin32Error()));
                return 3;
            }

            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size); // sets size; fails with ERROR_INSUFFICIENT_BUFFER
            if (size == IntPtr.Zero)
            {
                emitControl("launch_failed", Win32Msg("InitializeProcThreadAttributeList", Marshal.GetLastWin32Error()));
                return 3;
            }
            attrList = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref size))
            {
                emitControl("launch_failed", Win32Msg("InitializeProcThreadAttributeList", Marshal.GetLastWin32Error()));
                return 3;
            }
            handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handleList, 0 * IntPtr.Size, inRead);
            Marshal.WriteIntPtr(handleList, 1 * IntPtr.Size, outWrite);
            Marshal.WriteIntPtr(handleList, 2 * IntPtr.Size, errWrite);
            if (!UpdateProcThreadAttribute(attrList, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                handleList, (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
            {
                emitControl("launch_failed", Win32Msg("UpdateProcThreadAttribute", Marshal.GetLastWin32Error()));
                return 3;
            }

            BrokerStartupInfoEx siex = new BrokerStartupInfoEx();
            siex.StartupInfo.cb = Marshal.SizeOf(typeof(BrokerStartupInfoEx));
            siex.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            siex.StartupInfo.hStdInput = inRead;
            siex.StartupInfo.hStdOutput = outWrite;
            siex.StartupInfo.hStdError = errWrite;
            siex.lpAttributeList = attrList;

            StringBuilder commandLine = cfg.VerbatimCommandLine != null
                ? new StringBuilder(cfg.VerbatimCommandLine)
                : BuildCommandLineFromArgs(cfg.ApplicationName, cfg.Args);
            byte[] envBytes = BuildEnvironmentBlock(cfg.EnvPairs);
            envBlock = Marshal.AllocHGlobal(envBytes.Length);
            Marshal.Copy(envBytes, 0, envBlock, envBytes.Length);

            IntPtr siexPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(BrokerStartupInfoEx)));
            try
            {
                Marshal.StructureToPtr(siex, siexPtr, false);
                if (!CreateProcessW(cfg.VerbatimCommandLine != null ? null : cfg.ApplicationName, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                    CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                    envBlock, string.IsNullOrEmpty(cfg.Cwd) ? null : cfg.Cwd, siexPtr, out st.Root))
                {
                    emitControl("launch_failed", Win32Msg("CreateProcessW", Marshal.GetLastWin32Error()));
                    return 3;
                }
            }
            finally
            {
                Marshal.FreeHGlobal(siexPtr);
            }

            if (!AssignProcessToJobObject(st.Job, st.Root.hProcess))
            {
                TerminateProcess(st.Root.hProcess, 1);
                emitControl("launch_failed", Win32Msg("AssignProcessToJobObject", Marshal.GetLastWin32Error()));
                return 3;
            }

            long rootCreated, rootExited, rootKernel, rootUser;
            if (!GetProcessTimes(st.Root.hProcess, out rootCreated, out rootExited, out rootKernel, out rootUser) || rootCreated <= 0)
            {
                emitControl("launch_failed", Win32Msg("GetProcessTimes", Marshal.GetLastWin32Error()));
                return 3;
            }
            string rootCreationTime = rootCreated.ToString(CultureInfo.InvariantCulture);

            emitControl("launched", "{\"launch_uuid\":\"" + JsonEscape(cfg.LaunchUuid) +
                "\",\"named_job\":\"" + JsonEscape(cfg.JobName) +
                "\",\"root_pid\":" + st.Root.dwProcessId.ToString(CultureInfo.InvariantCulture) +
                ",\"root_creation_time\":\"" + rootCreationTime +
                "\",\"owner_pid\":" + cfg.OwnerPid.ToString(CultureInfo.InvariantCulture) +
                ",\"owner_creation_time\":\"" + JsonEscape(cfg.OwnerCreationTime ?? "") +
                "\",\"helper_pid\":" + GetCurrentProcessId().ToString(CultureInfo.InvariantCulture) + "}");

            CloseHandle(outWrite); outWrite = IntPtr.Zero;
            CloseHandle(errWrite); errWrite = IntPtr.Zero;
            CloseHandle(inRead); inRead = IntPtr.Zero;

            outStream = new FileStream(new SafeFileHandle(outRead, true), FileAccess.Read, NATIVE_CHUNK, false);
            errStream = new FileStream(new SafeFileHandle(errRead, true), FileAccess.Read, NATIVE_CHUNK, false);
            outRead = IntPtr.Zero; errRead = IntPtr.Zero;

            outThread = new Thread(delegate()
            {
                try
                {
                    byte[] buf = new byte[NATIVE_CHUNK];
                    int n;
                    while ((n = outStream.Read(buf, 0, buf.Length)) > 0)
                    {
                        byte[] copy = new byte[n];
                        Buffer.BlockCopy(buf, 0, copy, 0, n);
                        st.NativeOut.Add(copy); // blocks when queue full (bounded)
                    }
                }
                catch { }
                finally
                {
                    try { st.NativeOut.CompleteAdding(); } catch { }
                    st.OutReaderDone = true;
                }
            });
            outThread.IsBackground = true;
            outThread.Start();

            errThread = new Thread(delegate()
            {
                try
                {
                    byte[] buf = new byte[NATIVE_CHUNK];
                    int n;
                    while ((n = errStream.Read(buf, 0, buf.Length)) > 0)
                    {
                        byte[] copy = new byte[n];
                        Buffer.BlockCopy(buf, 0, copy, 0, n);
                        st.NativeErr.Add(copy);
                    }
                }
                catch { }
                finally
                {
                    try { st.NativeErr.CompleteAdding(); } catch { }
                    st.ErrReaderDone = true;
                }
            });
            errThread.IsBackground = true;
            errThread.Start();

            if (cfg.ChildStdin != null && cfg.ChildStdin.Length > 0)
            {
                byte[] payload = cfg.ChildStdin;
                IntPtr stdinWrite = inWrite;
                inWrite = IntPtr.Zero;
                childStdinThread = new Thread(delegate()
                {
                    try
                    {
                        using (FileStream fs = new FileStream(new SafeFileHandle(stdinWrite, true), FileAccess.Write, NATIVE_CHUNK, false))
                        {
                            fs.Write(payload, 0, payload.Length);
                            fs.Flush();
                        }
                    }
                    catch { }
                });
                childStdinThread.IsBackground = true;
                childStdinThread.Start();
            }
            else
            {
                CloseHandle(inWrite); inWrite = IntPtr.Zero;
            }

            controlThread = new Thread(delegate()
            {
                try
                {
                    string prefix = cfg.Nonce + " ";
                    while (true)
                    {
                        string line = ReadControlLine();
                        if (line == null) break;
                        if (line.Length > prefix.Length && line.StartsWith(prefix, StringComparison.Ordinal))
                        {
                            string op = line.Substring(prefix.Length).Trim();
                            if (op == "resume") st.ResumeRequested = true;
                            else if (op == "cancel") st.CancelRequested = true;
                        }
                    }
                }
                catch { }
                st.StdinEof = true;
            });
            controlThread.IsBackground = true;
            controlThread.Start();

            int resumeDeadlineMs = Environment.TickCount + Math.Max(1000, cfg.ResumeTimeoutMs);
            int terminateStartedMs = -1;
            while (true)
            {
                if (st.TerminationReason == null)
                {
                    if (st.StdinEof || OwnerIsDead(st)) st.TerminationReason = "owner_lost";
                    else if (st.CancelRequested) st.TerminationReason = "cancel";
                }

                if (st.TerminationReason != null)
                {
                    TerminateJobObject(st.Job, 1);
                    if (terminateStartedMs < 0) terminateStartedMs = Environment.TickCount;
                }
                else if (!st.Resumed)
                {
                    if (st.ResumeRequested)
                    {
                        uint previous = ResumeThread(st.Root.hThread);
                        if (previous == 0xFFFFFFFF)
                        {
                            st.TerminationReason = "resume_failed";
                            emitControl("helper_error", Win32Msg("ResumeThread", Marshal.GetLastWin32Error()));
                        }
                        else
                        {
                            st.Resumed = true;
                            CloseHandle(st.Root.hThread);
                            st.Root.hThread = IntPtr.Zero;
                            emitControl("resumed", "{}");
                        }
                    }
                    else if (Environment.TickCount > resumeDeadlineMs)
                    {
                        st.TerminationReason = "resume_timeout";
                        emitControl("helper_error", "{\"api\":\"resume_timeout\"}");
                    }
                }

                st.PumpNative();

                if (st.Resumed && !st.RootExited && WaitForSingleObject(st.Root.hProcess, 0) == WAIT_OBJECT_0)
                {
                    uint code;
                    if (!GetExitCodeProcess(st.Root.hProcess, out code)) throw new IOException("ROOT_EXIT_QUERY_FAILED");
                    st.RootExited = true;
                    st.RootExitCode = code;
                    emitControl("root_exit", "{\"exit_code\":" + code.ToString(CultureInfo.InvariantCulture) + "}");
                }

                if (st.TerminationReason != null)
                {
                    if (st.ActiveProcesses() == 0 && st.OutReaderDone && st.ErrReaderDone)
                    {
                        uint terminalCode;
                        if (WaitForSingleObject(st.Root.hProcess, 1000) != WAIT_OBJECT_0 ||
                            !GetExitCodeProcess(st.Root.hProcess, out terminalCode))
                        {
                            emitControl("terminated_unproven", "{\"reason\":\"root_exit_query_failed\"}");
                            return 5;
                        }
                        st.RootExitCode = terminalCode;
                        st.PumpNative();
                        JoinThreads(outThread, errThread);
                        emitControl("terminated", "{\"reason\":\"" + st.TerminationReason +
                            "\",\"root_exit_code\":" + st.RootExitCode.ToString(CultureInfo.InvariantCulture) + ",\"active\":0,\"drained\":true,\"resumed\":" + (st.Resumed ? "true" : "false") + "}");
                        return (int)st.RootExitCode;
                    }
                    if (terminateStartedMs >= 0 &&
                        Environment.TickCount - terminateStartedMs > Math.Max(1000, cfg.TerminateQuiesceMs))
                    {
                        emitControl("terminated_unproven", "{\"reason\":\"" + st.TerminationReason + "\"}");
                        return 5;
                    }
                }
                else if (st.Resumed && st.RootExited &&
                    st.ActiveProcesses() == 0 && st.OutReaderDone && st.ErrReaderDone)
                {
                    st.PumpNative();
                    JoinThreads(outThread, errThread);
                    emitControl("exit", "{\"exit_code\":" + st.RootExitCode.ToString(CultureInfo.InvariantCulture) + ",\"active\":0,\"drained\":true,\"resumed\":true}");
                    return (int)st.RootExitCode;
                }

                Thread.Sleep(15);
            }
        }
        catch (Exception e)
        {
            try { emitControl("helper_error", "{\"message\":\"" + JsonEscape(e.Message) + "\"}"); } catch { }
            return 6;
        }
        finally
        {
            if (st.Root.hThread != IntPtr.Zero) CloseHandle(st.Root.hThread);
            if (st.Root.hProcess != IntPtr.Zero) CloseHandle(st.Root.hProcess);
            if (st.Owner != IntPtr.Zero) CloseHandle(st.Owner);
            if (outStream != null) outStream.Dispose();
            if (errStream != null) errStream.Dispose();
            if (inWrite != IntPtr.Zero) CloseHandle(inWrite);
            if (outRead != IntPtr.Zero) CloseHandle(outRead);
            if (errRead != IntPtr.Zero) CloseHandle(errRead);
            if (outWrite != IntPtr.Zero) CloseHandle(outWrite);
            if (errWrite != IntPtr.Zero) CloseHandle(errWrite);
            if (inRead != IntPtr.Zero) CloseHandle(inRead);
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            if (attrList != IntPtr.Zero)
            {
                try { DeleteProcThreadAttributeList(attrList); } catch { }
                Marshal.FreeHGlobal(attrList);
            }
            if (envBlock != IntPtr.Zero) Marshal.FreeHGlobal(envBlock);
            if (st.Job != IntPtr.Zero) CloseHandle(st.Job);
        }
    }

    private static StringBuilder BuildCommandLineFromArgs(string applicationName, string[] args)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append(QuoteArg(applicationName));
        for (int i = 0; i < args.Length; i++)
        {
            sb.Append(' ');
            sb.Append(QuoteArg(args[i]));
        }
        return sb;
    }

    private static bool OwnerIsDead(RunState st)
    {
        if (st.Owner == IntPtr.Zero) return false;
        return WaitForSingleObject(st.Owner, 0) == WAIT_OBJECT_0;
    }

    private static void JoinThreads(Thread a, Thread b)
    {
        if (a != null) a.Join(5000);
        if (b != null) b.Join(5000);
    }
}
'@
Add-Type -TypeDefinition $nativeSource -Language CSharp

$CONFIG_CAP_BYTES = 8MB

try {
  $stdoutStream = [System.Console]::OpenStandardOutput()

  $configJson = [BrokerJobNative]::ReadConfigLine($CONFIG_CAP_BYTES)
  if ([string]::IsNullOrWhiteSpace($configJson)) { throw "EMPTY_CONFIG" }
  $cfg = $configJson | ConvertFrom-Json

  $nonce = [string]$cfg.nonce
  if ($nonce -notmatch '^[0-9a-f]{32}$') { throw "BAD_NONCE" }
  $launchUuid = [string]$cfg.launch_uuid
  if ($launchUuid -notmatch '^[0-9a-fA-F-]{1,64}$') { throw "BAD_LAUNCH_UUID" }
  $jobName = [string]$cfg.job_name
  if ($jobName -notmatch '^[0-9A-Za-z_\\:.-]{1,120}$') { throw "BAD_JOB_NAME" }

  $outJob = New-Object BrokerJobConfig
  $outJob.Nonce = $nonce
  $outJob.LaunchUuid = $launchUuid
  $outJob.JobName = $jobName
  if ($null -ne $cfg.verbatim_command_line) {
    if ([string]$cfg.verbatim_command_line -match '[\0\r\n]') { throw "BAD_COMMAND_LINE" }
    $outJob.VerbatimCommandLine = [string]$cfg.verbatim_command_line
  } else {
    if ($null -eq $cfg.application_name -or [string]$cfg.application_name -match '\0') { throw "BAD_APPLICATION" }
    $outJob.ApplicationName = [string]$cfg.application_name
    $argList = New-Object 'System.Collections.Generic.List[string]'
    foreach ($a in @($cfg.args)) {
      $t = [string]$a
      if ($t.IndexOf([char]0) -ge 0) { throw "BAD_ARG_NUL" }
      $argList.Add($t)
    }
    $outJob.Args = $argList.ToArray()
  }
  if ([string]$cfg.cwd -match '\0') { throw "BAD_CWD" }
  $outJob.Cwd = [string]$cfg.cwd
  $envPairs = New-Object 'System.Collections.Generic.List[string]'
  foreach ($p in @($cfg.env_pairs)) {
    $t = [string]$p
    if ($t.IndexOf([char]0) -ge 0) { throw "BAD_ENV_NUL" }
    $envPairs.Add($t)
  }
  $outJob.EnvPairs = $envPairs.ToArray()
  if ($null -ne $cfg.child_stdin_b64 -and [string]$cfg.child_stdin_b64 -ne '') {
    $outJob.ChildStdin = [Convert]::FromBase64String([string]$cfg.child_stdin_b64)
  }
  $outJob.OwnerPid = [int]$cfg.owner_pid
  if ($outJob.OwnerPid -le 0) { throw "BAD_OWNER_PID" }
  $ownerCreation = [string]$cfg.owner_creation_time
  if ($ownerCreation -eq '' -or $ownerCreation -notmatch '^[0-9]{1,19}$') { throw "BAD_OWNER_CREATION" }
  $outJob.OwnerCreationTime = $ownerCreation
  $outJob.ResumeTimeoutMs = [int]$cfg.resume_timeout_ms
  $outJob.TerminateQuiesceMs = [int]$cfg.terminate_quiesce_ms
  if ($null -ne $cfg.max_native_output_bytes) {
    $outJob.MaxNativeOutputBytes = [long]$cfg.max_native_output_bytes
  } else {
    $outJob.MaxNativeOutputBytes = 8MB
  }

  $emitControl = [Action[string,string]]{
    param([string]$op, [string]$json)
    $line = $nonce + ' ' + $op + ' ' + $json + "`n"
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($line)
    $stdoutStream.Write($bytes, 0, $bytes.Length)
    $stdoutStream.Flush()
  }

  $exitCode = [BrokerJobNative]::Run($outJob, $emitControl)
  exit $exitCode
} catch {
  try { [Console]::Error.WriteLine('broker-windows-job-helper: ' + $_.Exception.Message) } catch {}
  exit 9
}
