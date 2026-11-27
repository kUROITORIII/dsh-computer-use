param(
    [switch]$Demo,
    [string]$Snapshot = '',
    [string]$Dump = '',
    [string]$Accent = '#2F7DF6',
    [int]$NoticeSeconds = 5,
    [string]$Hotkey = '',
    [string]$DockHotkey = '',
    [string]$PauseHotkey = '',
    [switch]$DangerDemo,
    [switch]$StartHidden,
    [string]$State = '',
    [int]$CardWidth = 520,
    [int]$CardHeight = 680,
    [int]$CardMargin = 0,
    [string]$CardCorner = 'topright',
    [string]$CardX = '',
    [string]$CardY = ''
)

$ErrorActionPreference = 'Stop'
$script:earlyLog = Join-Path $env:TEMP 'dsh-overlay.log'
try {
    Add-Content -LiteralPath $script:earlyLog -Value ((Get-Date).ToString('HH:mm:ss.fff') + ' boot pid=' + $PID + ' snapshot=' + $Snapshot) -Encoding UTF8
} catch {
}
trap {
    try {
        Add-Content -LiteralPath $script:earlyLog -Value ((Get-Date).ToString('HH:mm:ss.fff') + ' CRASH ' + $_.Exception.Message) -Encoding UTF8
    } catch {
    }
    exit 1
}

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class OverlayWin32
{
    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowLong(IntPtr hWnd, int index);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int SetWindowLong(IntPtr hWnd, int index, int value);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll")]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint key);

    [DllImport("user32.dll")]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}

public static class StdinPump
{
    public static readonly ConcurrentQueue<string> Queue = new ConcurrentQueue<string>();
    public static volatile bool Eof;

    public static void Start()
    {
        Thread thread = new Thread(Run);
        thread.IsBackground = true;
        thread.Name = "dsh-overlay-stdin";
        thread.Start();
    }

    private static void Run()
    {
        StreamReader reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        string line;
        while ((line = reader.ReadLine()) != null)
        {
            Queue.Enqueue(line);
        }
        Eof = true;
    }
}
'@

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

/// <summary>
/// Records the default microphone as canonical 16 kHz mono PCM16 audio and
/// writes it to a WAV file, so the recording can be handed to the same local
/// recognizer the DSH app itself uses.
/// </summary>
public static class VoiceRecorder
{
    private const int WAVE_MAPPER = -1;
    private const int CALLBACK_FUNCTION = 0x00030000;
    private const int WIM_DATA = 0x03C0;
    private const int WHDR_DONE = 0x00000001;
    private const int BUFFER_COUNT = 4;
    private const int BYTES_PER_BUFFER = 3200;

    [StructLayout(LayoutKind.Sequential)]
    private struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WAVEHDR
    {
        public IntPtr lpData;
        public uint dwBufferLength;
        public uint dwBytesRecorded;
        public uint dwUser;
        public uint dwFlags;
        public uint dwLoops;
        public IntPtr lpNext;
        public uint reserved;
    }

    private delegate void WaveInProc(IntPtr device, uint message, IntPtr instance, IntPtr param1, IntPtr param2);

    [DllImport("winmm.dll")] private static extern int waveInOpen(out IntPtr device, int id, ref WAVEFORMATEX format, WaveInProc callback, IntPtr instance, int flags);
    [DllImport("winmm.dll")] private static extern int waveInPrepareHeader(IntPtr device, IntPtr header, int size);
    [DllImport("winmm.dll")] private static extern int waveInUnprepareHeader(IntPtr device, IntPtr header, int size);
    [DllImport("winmm.dll")] private static extern int waveInAddBuffer(IntPtr device, IntPtr header, int size);
    [DllImport("winmm.dll")] private static extern int waveInStart(IntPtr device);
    [DllImport("winmm.dll")] private static extern int waveInStop(IntPtr device);
    [DllImport("winmm.dll")] private static extern int waveInReset(IntPtr device);
    [DllImport("winmm.dll")] private static extern int waveInClose(IntPtr device);

    private static readonly object Gate = new object();
    private static readonly MemoryStream Audio = new MemoryStream();
    private static readonly List<IntPtr> Headers = new List<IntPtr>();
    private static readonly List<IntPtr> Blocks = new List<IntPtr>();
    private static IntPtr deviceHandle = IntPtr.Zero;
    private static WaveInProc callback;
    private static volatile bool recording;
    private static volatile int level;
    private static volatile bool heardSpeech;
    private static DateTime startedAt;

    public static bool Recording { get { return recording; } }
    public static int Level { get { return level; } }
    public static bool HeardSpeech { get { return heardSpeech; } }
    public static double Seconds
    {
        get
        {
            if (!recording) return 0;
            return (DateTime.UtcNow - startedAt).TotalSeconds;
        }
    }

    /// <summary>Open the microphone and start buffering; returns null on success.</summary>
    public static string Start()
    {
        lock (Gate)
        {
            try
            {
                if (recording) return null;
                Headers.Clear();
                Blocks.Clear();
                Audio.SetLength(0);
                level = 0;
                heardSpeech = false;

                WAVEFORMATEX format = new WAVEFORMATEX();
                format.wFormatTag = 1;
                format.nChannels = 1;
                format.nSamplesPerSec = 16000;
                format.wBitsPerSample = 16;
                format.nBlockAlign = 2;
                format.nAvgBytesPerSec = 32000;
                format.cbSize = 0;

                callback = OnData;
                IntPtr opened;
                int status = waveInOpen(out opened, WAVE_MAPPER, ref format, callback, IntPtr.Zero, CALLBACK_FUNCTION);
                if (status != 0) return "无法打开麦克风（错误码 " + status + "）";
                deviceHandle = opened;

                int headerSize = Marshal.SizeOf(typeof(WAVEHDR));
                for (int index = 0; index < BUFFER_COUNT; index++)
                {
                    IntPtr block = Marshal.AllocHGlobal(BYTES_PER_BUFFER);
                    IntPtr header = Marshal.AllocHGlobal(headerSize);
                    WAVEHDR data = new WAVEHDR();
                    data.lpData = block;
                    data.dwBufferLength = BYTES_PER_BUFFER;
                    data.dwFlags = 0;
                    Marshal.StructureToPtr(data, header, false);
                    if (waveInPrepareHeader(deviceHandle, header, headerSize) != 0) return "无法准备录音缓冲区";
                    waveInAddBuffer(deviceHandle, header, headerSize);
                    Blocks.Add(block);
                    Headers.Add(header);
                }

                startedAt = DateTime.UtcNow;
                recording = true;
                if (waveInStart(deviceHandle) != 0)
                {
                    recording = false;
                    return "无法启动录音";
                }
                return null;
            }
            catch (Exception error)
            {
                recording = false;
                return error.Message;
            }
        }
    }

    private static void OnData(IntPtr device, uint message, IntPtr instance, IntPtr param1, IntPtr param2)
    {
        if (message != WIM_DATA) return;
        try
        {
            int headerSize = Marshal.SizeOf(typeof(WAVEHDR));
            WAVEHDR header = (WAVEHDR)Marshal.PtrToStructure(param1, typeof(WAVEHDR));
            int bytes = (int)header.dwBytesRecorded;
            if (bytes > 0)
            {
                byte[] chunk = new byte[bytes];
                Marshal.Copy(header.lpData, chunk, 0, bytes);
                lock (Gate)
                {
                    if (recording) Audio.Write(chunk, 0, bytes);
                }
                int peak = 0;
                for (int index = 0; index + 1 < bytes; index += 2)
                {
                    int sample = Math.Abs((short)(chunk[index] | (chunk[index + 1] << 8)));
                    if (sample > peak) peak = sample;
                }
                level = peak;
                if (peak > 900) heardSpeech = true;
            }
            if (recording) waveInAddBuffer(device, param1, headerSize);
        }
        catch (Exception)
        {
        }
    }

    /// <summary>Stop recording and write the WAV file; returns its path or an error message.</summary>
    public static string Stop(string folder)
    {
        lock (Gate)
        {
            if (!recording) return "没有正在进行的录音";
            recording = false;
            try
            {
                waveInStop(deviceHandle);
                waveInReset(deviceHandle);
                int headerSize = Marshal.SizeOf(typeof(WAVEHDR));
                foreach (IntPtr header in Headers) waveInUnprepareHeader(deviceHandle, header, headerSize);
                waveInClose(deviceHandle);
            }
            catch (Exception)
            {
            }
            finally
            {
                deviceHandle = IntPtr.Zero;
                foreach (IntPtr block in Blocks) Marshal.FreeHGlobal(block);
                foreach (IntPtr header in Headers) Marshal.FreeHGlobal(header);
                Headers.Clear();
                Blocks.Clear();
            }

            if (Audio.Length < 1600) return "录音太短了";
            if (!Directory.Exists(folder)) Directory.CreateDirectory(folder);
            string path = Path.Combine(folder, "voice-" + DateTime.Now.Ticks + ".wav");
            using (FileStream file = new FileStream(path, FileMode.Create, FileAccess.Write))
            {
                int dataLength = (int)Audio.Length;
                byte[] header = BuildHeader(dataLength);
                file.Write(header, 0, header.Length);
                Audio.Position = 0;
                Audio.CopyTo(file);
            }
            Audio.SetLength(0);
            return path;
        }
    }

    private static byte[] BuildHeader(int dataLength)
    {
        byte[] header = new byte[44];
        System.Text.Encoding.ASCII.GetBytes("RIFF").CopyTo(header, 0);
        BitConverter.GetBytes(36 + dataLength).CopyTo(header, 4);
        System.Text.Encoding.ASCII.GetBytes("WAVE").CopyTo(header, 8);
        System.Text.Encoding.ASCII.GetBytes("fmt ").CopyTo(header, 12);
        BitConverter.GetBytes(16).CopyTo(header, 16);
        BitConverter.GetBytes((short)1).CopyTo(header, 20);
        BitConverter.GetBytes((short)1).CopyTo(header, 22);
        BitConverter.GetBytes(16000).CopyTo(header, 24);
        BitConverter.GetBytes(32000).CopyTo(header, 28);
        BitConverter.GetBytes((short)2).CopyTo(header, 32);
        BitConverter.GetBytes((short)16).CopyTo(header, 34);
        System.Text.Encoding.ASCII.GetBytes("data").CopyTo(header, 36);
        BitConverter.GetBytes(dataLength).CopyTo(header, 40);
        return header;
    }
}

'@ -ReferencedAssemblies $speechReference

$utf8 = New-Object System.Text.UTF8Encoding($false)
$script:output = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$script:output.AutoFlush = $true

$script:colors = @{
    capture   = '#6FA8FF'
    input     = '#FF9A4D'
    ok        = '#5FD08A'
    error     = '#FF6B6B'
    user      = '#B58CFF'
    assistant = '#E8E8EF'
    tool      = '#7FD1C7'
    detail    = '#C9C9D2'
}

$cardXaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="DSH computer use"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False" Topmost="True" ShowActivated="False"
        ResizeMode="CanResizeWithGrip" SizeToContent="Manual"
        Width="520" Height="680" MinWidth="380" MinHeight="320"
        FontFamily="Microsoft YaHei UI, Segoe UI">
  <Window.Resources>
    <Style x:Key="FilledButton" TargetType="Button">
      <Setter Property="Foreground" Value="#1B1B1E"/>
      <Setter Property="Background" Value="#2F7DF6"/>
      <Setter Property="BorderThickness" Value="0"/>
      <Setter Property="Padding" Value="12,5"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="B" Background="{TemplateBinding Background}" CornerRadius="7" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="B" Property="Opacity" Value="0.85"/></Trigger>
              <Trigger Property="IsPressed" Value="True"><Setter TargetName="B" Property="Opacity" Value="0.65"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="GhostButton" TargetType="Button">
      <Setter Property="Foreground" Value="#D6D6DE"/>
      <Setter Property="Background" Value="#2C2C33"/>
      <Setter Property="BorderThickness" Value="0"/>
      <Setter Property="Padding" Value="12,5"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="B" Background="{TemplateBinding Background}" CornerRadius="7" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="B" Property="Opacity" Value="0.8"/></Trigger>
              <Trigger Property="IsPressed" Value="True"><Setter TargetName="B" Property="Opacity" Value="0.6"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <Grid>
  <Border x:Name="CardBorder" Background="#F41B1B1F" CornerRadius="14" BorderThickness="1" BorderBrush="#33FFFFFF" Padding="16">
    <Grid>
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="*"/>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
      </Grid.RowDefinitions>
      <Grid Grid.Row="0">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <Ellipse x:Name="PulseDot" Width="8" Height="8" Fill="#2F7DF6" VerticalAlignment="Center" Margin="0,0,9,0"/>
        <TextBlock x:Name="TitleText" Grid.Column="1" Text="DeepSeek 正在使用你的电脑" Foreground="#F3F3F7" FontSize="13" FontWeight="SemiBold" VerticalAlignment="Center" TextTrimming="CharacterEllipsis"/>
        <Button x:Name="StopButton" Grid.Column="2" Content="停止" Style="{StaticResource GhostButton}" Padding="10,4" Margin="8,0,0,0"/>
        <Border x:Name="ProgressTrack" Grid.ColumnSpan="3" Height="2" VerticalAlignment="Bottom" Margin="0,9,0,0" Background="#1FFFFFFF" CornerRadius="1" Visibility="Collapsed">
          <Rectangle x:Name="ProgressFill" HorizontalAlignment="Left" Height="2" RadiusX="1" RadiusY="1" Fill="#2F7DF6" RenderTransformOrigin="0,0.5">
            <Rectangle.RenderTransform>
              <ScaleTransform x:Name="ProgressScale" ScaleX="0" ScaleY="1"/>
            </Rectangle.RenderTransform>
          </Rectangle>
        </Border>
      </Grid>
      <TextBlock x:Name="StatusText" Grid.Row="1" Margin="17,7,0,0" Text="" Foreground="#A9A9B4" FontSize="11.5" TextWrapping="Wrap"/>
      <TextBlock x:Name="LiveText" Grid.Row="2" Visibility="Collapsed" Margin="17,6,0,0" Foreground="#9FC0E8" FontSize="11" TextWrapping="Wrap" MaxHeight="56" ClipToBounds="True"/>
      <Border Grid.Row="3" Height="1" Background="#1FFFFFFF" Margin="0,12,0,0"/>
      <Grid Grid.Row="4" Margin="0,10,0,0">
        <ScrollViewer x:Name="FeedScroll" VerticalScrollBarVisibility="Hidden" HorizontalScrollBarVisibility="Disabled">
          <StackPanel x:Name="Feed"/>
        </ScrollViewer>
        <Rectangle Height="24" VerticalAlignment="Bottom" IsHitTestVisible="False">
          <Rectangle.Fill>
            <LinearGradientBrush StartPoint="0,0" EndPoint="0,1">
              <GradientStop Color="#001B1B1F" Offset="0"/>
              <GradientStop Color="#F41B1B1F" Offset="1"/>
            </LinearGradientBrush>
          </Rectangle.Fill>
        </Rectangle>
      </Grid>
      <Border x:Name="PermissionPanel" Grid.Row="5" Visibility="Collapsed" Margin="0,12,0,0" Background="#1F2229" BorderBrush="#662F7DF6" BorderThickness="1" CornerRadius="10" Padding="12">
        <StackPanel>
          <TextBlock x:Name="PermissionTitle" Foreground="#CBD9F5" FontSize="12.5" FontWeight="SemiBold" TextWrapping="Wrap"/>
          <Border x:Name="PermissionAppChip" Visibility="Collapsed" Background="#332F7DF6" CornerRadius="5" Padding="6,2" Margin="0,7,0,0" HorizontalAlignment="Left">
            <TextBlock x:Name="PermissionAppText" FontSize="10.5" Foreground="#86B2FF"/>
          </Border>
          <TextBlock x:Name="PermissionDetail" Foreground="#C6C6CE" FontSize="11.5" TextWrapping="Wrap" Margin="0,5,0,0"/>
          <TextBlock x:Name="PermissionRisk" Foreground="#FFB27A" FontSize="11" TextWrapping="Wrap" Margin="0,8,0,0"/>
          <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,12,0,0">
            <Button x:Name="DenyButton" Content="拒绝" Style="{StaticResource GhostButton}" Margin="0,0,8,0"/>
            <Button x:Name="AllowButton" Content="允许本次会话" Style="{StaticResource FilledButton}"/>
          </StackPanel>
        </StackPanel>
      </Border>
      <Grid Grid.Row="6" Margin="0,12,0,0">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <Border Background="#26262C" CornerRadius="8" Padding="9,0" BorderThickness="1" BorderBrush="#2EFFFFFF">
          <TextBox x:Name="ReplyBox" Background="Transparent" BorderThickness="0" Foreground="#EDEDF2" CaretBrush="#EDEDF2"
                   FontSize="12" Height="30" VerticalContentAlignment="Center"/>
        </Border>
        <Button x:Name="MicButton" Grid.Column="1" Style="{StaticResource GhostButton}" Padding="9,4" Margin="8,0,0,0" ToolTip="语音输入">
          <Canvas Width="12" Height="15">
            <Rectangle x:Name="MicCapsule" Canvas.Left="4" Canvas.Top="0" Width="4" Height="8" RadiusX="2" RadiusY="2" Fill="#D6D6DE"/>
            <Path x:Name="MicArc" Data="M 0.6,6.2 A 5.4,5.4 0 0 0 11.4,6.2" Stroke="#D6D6DE" StrokeThickness="1.4" Canvas.Left="0" Canvas.Top="0"/>
            <Line x:Name="MicStem" X1="6" Y1="11.6" X2="6" Y2="14" Stroke="#D6D6DE" StrokeThickness="1.4"/>
          </Canvas>
        </Button>
        <Button x:Name="SendButton" Grid.Column="2" Content="发送" Style="{StaticResource FilledButton}" Margin="8,0,0,0"/>
      </Grid>
      <Grid Grid.Row="7" Margin="2,8,0,0">
        <TextBlock x:Name="HintText" Text="Enter 排队到本轮结束后发送 · Ctrl+Enter 立即发送" Foreground="#6E6E7A" FontSize="10" VerticalAlignment="Center"/>
        <Canvas Width="12" Height="12" HorizontalAlignment="Right" VerticalAlignment="Center" IsHitTestVisible="False">
          <Line X1="2" Y1="12" X2="12" Y2="2" Stroke="#4A4A55" StrokeThickness="1.2"/>
          <Line X1="7" Y1="12" X2="12" Y2="7" Stroke="#4A4A55" StrokeThickness="1.2"/>
        </Canvas>
      </Grid>
    </Grid>
  </Border>
  <Border x:Name="ResizeLeft" Width="6" HorizontalAlignment="Left" Background="Transparent" Cursor="SizeWE"/>
  <Border x:Name="ResizeBottom" Height="6" VerticalAlignment="Bottom" Background="Transparent" Cursor="SizeNS"/>
  <Border x:Name="ResizeCorner" Width="16" Height="16" HorizontalAlignment="Left" VerticalAlignment="Bottom" Background="Transparent" Cursor="SizeNWSE"/>
  </Grid>
</Window>

'@

$glowXaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="DSH computer use glow"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False" Topmost="True" ShowActivated="False" IsHitTestVisible="False"
        ResizeMode="NoResize">
  <Grid x:Name="GlowRoot" Opacity="0.8">
    <Rectangle x:Name="BandTop" VerticalAlignment="Top" Height="112"/>
    <Rectangle x:Name="BandBottom" VerticalAlignment="Bottom" Height="112"/>
    <Rectangle x:Name="BandLeft" HorizontalAlignment="Left" Width="112"/>
    <Rectangle x:Name="BandRight" HorizontalAlignment="Right" Width="112"/>
    <Border x:Name="EdgeLine" BorderThickness="2" Opacity="0.9">
      <Border.Effect>
        <DropShadowEffect ShadowDepth="0" Opacity="0.9"/>
      </Border.Effect>
    </Border>
    <Border x:Name="TargetFrame" Visibility="Collapsed" BorderThickness="4" CornerRadius="8" HorizontalAlignment="Left" VerticalAlignment="Top" IsHitTestVisible="False">
      <Border.Effect>
        <DropShadowEffect ShadowDepth="0" BlurRadius="26" Opacity="0.9"/>
      </Border.Effect>
    </Border>
    <Ellipse x:Name="ClickPoint" Width="34" Height="34" StrokeThickness="2.5" Visibility="Collapsed" HorizontalAlignment="Left" VerticalAlignment="Top" IsHitTestVisible="False"/>
    <Path x:Name="TargetFlow" Visibility="Collapsed" StrokeThickness="3" StrokeDashArray="150,1500" StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeDashCap="Round" HorizontalAlignment="Left" VerticalAlignment="Top" IsHitTestVisible="False"/>
    <Border x:Name="TargetLabel" Visibility="Collapsed" Background="#F2181A20" BorderThickness="1" CornerRadius="7" Padding="10,4" HorizontalAlignment="Left" VerticalAlignment="Top" IsHitTestVisible="False">
      <TextBlock x:Name="TargetLabelText" FontSize="11" Foreground="#F3F3F7"/>
    </Border>
    <Border x:Name="TargetPill" Visibility="Collapsed" Background="#F2181A20" BorderThickness="1" CornerRadius="9" Padding="12,6" HorizontalAlignment="Center" VerticalAlignment="Top" Margin="0,12,0,0" IsHitTestVisible="False">
      <StackPanel Orientation="Horizontal">
        <Ellipse x:Name="TargetPillDot" Width="8" Height="8" Margin="0,0,8,0" VerticalAlignment="Center"/>
        <TextBlock x:Name="TargetPillText" FontSize="12" Foreground="#F5F6FA" VerticalAlignment="Center"/>
      </StackPanel>
    </Border>  </Grid>
</Window>
'@

$bannerXaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="DSH computer use banner"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False" Topmost="True" ShowActivated="False"
        ResizeMode="NoResize" SizeToContent="WidthAndHeight"
        FontFamily="Microsoft YaHei UI, Segoe UI">
  <Border x:Name="BannerCard" CornerRadius="13" Background="#F21A1C22" BorderThickness="1" BorderBrush="#662F7DF6" Padding="12,5,14,5">
    <Border.Effect>
      <DropShadowEffect ShadowDepth="0" BlurRadius="18" Opacity="0.45" Color="#000000"/>
    </Border.Effect>
    <StackPanel Orientation="Horizontal">
      <Ellipse x:Name="BannerDot" Width="6" Height="6" Fill="#2F7DF6" VerticalAlignment="Center" Margin="0,0,8,0"/>
      <TextBlock x:Name="BannerText" Text="DeepSeek 正在使用你的电脑" FontSize="12" Foreground="#E8ECF4" VerticalAlignment="Center"/>
    </StackPanel>
  </Border>
</Window>
'@

$noticeXaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="DSH computer use notice"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False" Topmost="True" ShowActivated="False"
        ResizeMode="NoResize" SizeToContent="WidthAndHeight"
        FontFamily="Microsoft YaHei UI, Segoe UI">
  <Border x:Name="NoticeCard" CornerRadius="12" Background="#F00F1014" BorderThickness="1" BorderBrush="#33FFFFFF" Padding="18,10,24,11" RenderTransformOrigin="0.5,0.5">
    <Border.RenderTransform>
      <TransformGroup>
        <ScaleTransform x:Name="NoticeScale" ScaleX="1" ScaleY="1"/>
        <TranslateTransform x:Name="NoticeShift" Y="0"/>
      </TransformGroup>
    </Border.RenderTransform>
    <!-- No drop shadow: the outline has to sit inside the capsule, like the
         search bar the user pointed at, instead of radiating a glow outwards. -->
    <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
      <Ellipse x:Name="NoticeDot" Width="9" Height="9" Fill="#2F7DF6" Margin="0,0,10,0" VerticalAlignment="Center"/>
      <TextBlock x:Name="NoticeTitle" Text="DeepSeek 正在使用你的电脑" FontSize="14" FontWeight="SemiBold" Foreground="#F2F4F8" VerticalAlignment="Center"/>
    </StackPanel>
  </Border>
</Window>
'@

# A floating copy of the picture the agent just captured. While docked the card is
# hidden, so this is the only place the user can see "what it is looking at" without
# scrolling the conversation.
$previewXaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="DSH computer use preview"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False" Topmost="True" ShowActivated="False"
        ResizeMode="NoResize" SizeToContent="WidthAndHeight"
        FontFamily="Microsoft YaHei UI, Segoe UI">
  <Border x:Name="PreviewCard" CornerRadius="12" Background="#F20F1014" BorderThickness="1" BorderBrush="#4D2F7DF6" Padding="6">
    <Border.Effect>
      <DropShadowEffect ShadowDepth="0" BlurRadius="26" Opacity="0.45" Color="#000000"/>
    </Border.Effect>
    <StackPanel>
      <Image x:Name="PreviewImage" Width="320" Height="180" Stretch="Uniform" RenderOptions.BitmapScalingMode="HighQuality"/>
      <TextBlock x:Name="PreviewCaption" Text="截屏预览" FontSize="11" Foreground="#98A2B3" Margin="2,6,2,2" TextTrimming="CharacterEllipsis" MaxWidth="320"/>
    </StackPanel>
  </Border>
</Window>
'@

$script:card = [System.Windows.Markup.XamlReader]::Parse($cardXaml)
$script:glow = [System.Windows.Markup.XamlReader]::Parse($glowXaml)
$script:banner = [System.Windows.Markup.XamlReader]::Parse($bannerXaml)
$script:notice = [System.Windows.Markup.XamlReader]::Parse($noticeXaml)
$script:preview = [System.Windows.Markup.XamlReader]::Parse($previewXaml)

# A small always-interactive handle. The preview itself stays click-through, so a
# screenshot lying under the pointer never eats a click; this strip is the single
# place the user can grab to move the preview when no control window owns it.
$previewGripXaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="DSH computer use grip"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False" Topmost="True" ShowActivated="False"
        ResizeMode="NoResize" Width="34" Height="22" Cursor="SizeAll">
  <Border x:Name="GripCard" CornerRadius="7" Background="#F20F1014" BorderThickness="1" BorderBrush="#4D2F7DF6">
    <TextBlock Text="⣿" FontSize="12" Foreground="#8FB6F5" HorizontalAlignment="Center" VerticalAlignment="Center"/>
  </Border>
</Window>
'@
$script:grip = [System.Windows.Markup.XamlReader]::Parse($previewGripXaml)

# Where a dragged preview is remembered, and the drag state itself.
$script:previewPosPath = Join-Path $env:TEMP 'dsh-computer-use-previewpos.json'
$script:gripDrag = $false
$script:gripStartCursor = [System.Windows.Point]::new(0, 0)
$script:gripStartLeft = 0.0
$script:gripStartTop = 0.0
$script:dpiScale = 1.0
try { $script:dpiScale = [System.Windows.Media.VisualTreeHelper]::GetDpi($script:preview).DpiScaleX } catch { }
if ($script:dpiScale -le 0) { $script:dpiScale = 1.0 }

function Find-Element($root, [string]$name) { return $root.FindName($name) }

$pulseDot = Find-Element $script:card 'PulseDot'
$titleText = Find-Element $script:card 'TitleText'
$statusText = Find-Element $script:card 'StatusText'
$liveText = Find-Element $script:card 'LiveText'
$feedScroll = Find-Element $script:card 'FeedScroll'
$feed = Find-Element $script:card 'Feed'
$hintText = Find-Element $script:card 'HintText'
$permissionPanel = Find-Element $script:card 'PermissionPanel'
$permissionTitle = Find-Element $script:card 'PermissionTitle'
$permissionAppChip = Find-Element $script:card 'PermissionAppChip'
$permissionAppText = Find-Element $script:card 'PermissionAppText'
$permissionDetail = Find-Element $script:card 'PermissionDetail'
$permissionRisk = Find-Element $script:card 'PermissionRisk'
$denyButton = Find-Element $script:card 'DenyButton'
$allowButton = Find-Element $script:card 'AllowButton'
$stopButton = Find-Element $script:card 'StopButton'
$replyBox = Find-Element $script:card 'ReplyBox'
$sendButton = Find-Element $script:card 'SendButton'
$micButton = Find-Element $script:card 'MicButton'
$micCapsule = Find-Element $script:card 'MicCapsule'
$micArc = Find-Element $script:card 'MicArc'
$micStem = Find-Element $script:card 'MicStem'
$bandTop = Find-Element $script:glow 'BandTop'
$bandBottom = Find-Element $script:glow 'BandBottom'
$bandLeft = Find-Element $script:glow 'BandLeft'
$bandRight = Find-Element $script:glow 'BandRight'
$edgeLine = Find-Element $script:glow 'EdgeLine'
$glowRoot = Find-Element $script:glow 'GlowRoot'
$progressTrack = Find-Element $script:card 'ProgressTrack'
$progressScale = Find-Element $script:card 'ProgressScale'
$progressFill = Find-Element $script:card 'ProgressFill'
$bannerCard = Find-Element $script:banner 'BannerCard'
$bannerDot = Find-Element $script:banner 'BannerDot'
$bannerText = Find-Element $script:banner 'BannerText'
$noticeCard = Find-Element $script:notice 'NoticeCard'
$noticeScale = Find-Element $script:notice 'NoticeScale'
$noticeShift = Find-Element $script:notice 'NoticeShift'
$noticeDot = Find-Element $script:notice 'NoticeDot'
$noticeTitle = Find-Element $script:notice 'NoticeTitle'
$previewCard = Find-Element $script:preview 'PreviewCard'
$previewImage = Find-Element $script:preview 'PreviewImage'
$previewCaption = Find-Element $script:preview 'PreviewCaption'
$resizeLeft = Find-Element $script:card 'ResizeLeft'
$resizeBottom = Find-Element $script:card 'ResizeBottom'
$resizeCorner = Find-Element $script:card 'ResizeCorner'
$targetFrame = Find-Element $script:glow 'TargetFrame'
$targetLabel = Find-Element $script:glow 'TargetLabel'
$targetLabelText = Find-Element $script:glow 'TargetLabelText'
$targetFlow = Find-Element $script:glow 'TargetFlow'
$targetPill = Find-Element $script:glow 'TargetPill'
$targetPillText = Find-Element $script:glow 'TargetPillText'
$targetPillDot = Find-Element $script:glow 'TargetPillDot'
$clickPoint = Find-Element $script:glow 'ClickPoint'

# ── accent colour ───────────────────────────────────────────────────────────
$accentValue = $Accent.TrimStart('#')
if ($accentValue.Length -ne 6) { $accentValue = '2F7DF6' }
$accentR = [Convert]::ToInt32($accentValue.Substring(0, 2), 16)
$accentG = [Convert]::ToInt32($accentValue.Substring(2, 2), 16)
$accentB = [Convert]::ToInt32($accentValue.Substring(4, 2), 16)

function New-AccentColor([int]$alpha) {
    return [System.Windows.Media.Color]::FromArgb($alpha, $accentR, $accentG, $accentB)
}

function New-LightChannel([int]$value, [double]$amount) {
    return [int][Math]::Min(255, [Math]::Round($value + (255 - $value) * $amount))
}

function New-BandBrush([string]$direction) {
    $brush = New-Object System.Windows.Media.LinearGradientBrush
    switch ($direction) {
        'top'    { $brush.StartPoint = '0,0'; $brush.EndPoint = '0,1' }
        'bottom' { $brush.StartPoint = '0,1'; $brush.EndPoint = '0,0' }
        'left'   { $brush.StartPoint = '0,0'; $brush.EndPoint = '1,0' }
        'right'  { $brush.StartPoint = '1,0'; $brush.EndPoint = '0,0' }
    }
    [void]$brush.GradientStops.Add((New-Object System.Windows.Media.GradientStop((New-AccentColor 224), 0)))
    [void]$brush.GradientStops.Add((New-Object System.Windows.Media.GradientStop((New-AccentColor 128), 0.34)))
    [void]$brush.GradientStops.Add((New-Object System.Windows.Media.GradientStop((New-AccentColor 52), 0.7)))
    [void]$brush.GradientStops.Add((New-Object System.Windows.Media.GradientStop((New-AccentColor 0), 1)))
    return $brush
}

$bandTop.Fill = New-BandBrush 'top'
$bandBottom.Fill = New-BandBrush 'bottom'
$bandLeft.Fill = New-BandBrush 'left'
$bandRight.Fill = New-BandBrush 'right'

# Rounded corner halo: a soft radial blob centred on each screen corner keeps
# the four bands from meeting in a hard right angle.
foreach ($corner in @(
        @{ h = 'Left'; v = 'Top'; m = @(-150.0, -150.0, 0.0, 0.0) },
        @{ h = 'Right'; v = 'Top'; m = @(0.0, -150.0, -150.0, 0.0) },
        @{ h = 'Left'; v = 'Bottom'; m = @(-150.0, 0.0, 0.0, -150.0) },
        @{ h = 'Right'; v = 'Bottom'; m = @(0.0, 0.0, -150.0, -150.0) })) {
    $blob = New-Object System.Windows.Shapes.Ellipse
    $blob.Width = 300
    $blob.Height = 300
    $blob.HorizontalAlignment = $corner.h
    $blob.VerticalAlignment = $corner.v
    $blob.Margin = [System.Windows.Thickness]::new([double]$corner.m[0], [double]$corner.m[1], [double]$corner.m[2], [double]$corner.m[3])
    $blob.IsHitTestVisible = $false
    $radial = New-Object System.Windows.Media.RadialGradientBrush
    $radial.Center = '0.5,0.5'
    $radial.GradientOrigin = '0.5,0.5'
    $radial.RadiusX = 0.5
    $radial.RadiusY = 0.5
    [void]$radial.GradientStops.Add((New-Object System.Windows.Media.GradientStop((New-AccentColor 150), 0)))
    [void]$radial.GradientStops.Add((New-Object System.Windows.Media.GradientStop((New-AccentColor 64), 0.5)))
    [void]$radial.GradientStops.Add((New-Object System.Windows.Media.GradientStop((New-AccentColor 0), 1)))
    $blob.Fill = $radial
    [void]$glowRoot.Children.Insert($glowRoot.Children.Count - 1, $blob)
}

$edgeLight = [System.Windows.Media.Color]::FromArgb(242, (New-LightChannel $accentR 0.5), (New-LightChannel $accentG 0.5), (New-LightChannel $accentB 0.5))
$edgeLine.BorderBrush = New-Object System.Windows.Media.SolidColorBrush($edgeLight)
$edgeLine.Effect.Color = New-AccentColor 255
$edgeLine.Effect.BlurRadius = 82

$pulseDot.Fill = New-Object System.Windows.Media.SolidColorBrush((New-AccentColor 255))
$whiteBrush = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(255, 255, 255, 255))
foreach ($button in @($allowButton, $sendButton)) {
    $button.Background = New-Object System.Windows.Media.SolidColorBrush((New-AccentColor 255))
    $button.Foreground = $whiteBrush
}
$liveText.Foreground = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(255, (New-LightChannel $accentR 0.45), (New-LightChannel $accentG 0.45), (New-LightChannel $accentB 0.45)))
$permissionPanel.BorderBrush = New-Object System.Windows.Media.SolidColorBrush((New-AccentColor 102))
$permissionPanel.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(255, [int](27 + ($accentR - 27) * 0.14), [int](27 + ($accentG - 27) * 0.14), [int](31 + ($accentB - 31) * 0.14)))
$permissionAppChip.Background = New-Object System.Windows.Media.SolidColorBrush((New-AccentColor 51))
$permissionAppText.Foreground = New-Object System.Windows.Media.SolidColorBrush((New-AccentColor 255))
$permissionTitle.Foreground = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(255, (New-LightChannel $accentR 0.8), (New-LightChannel $accentG 0.8), (New-LightChannel $accentB 0.8)))
$bannerDot.Fill = New-Object System.Windows.Media.SolidColorBrush((New-AccentColor 255))
$bannerCard.BorderBrush = New-Object System.Windows.Media.SolidColorBrush((New-AccentColor 130))
$progressFill.Fill = New-Object System.Windows.Media.SolidColorBrush((New-AccentColor 255))
$script:accentSolid = New-Object System.Windows.Media.SolidColorBrush((New-AccentColor 255))
$script:panelBackgroundDefault = $permissionPanel.Background
$script:panelBorderDefault = $permissionPanel.BorderBrush
$script:panelTitleDefault = $permissionTitle.Foreground
$script:chipBackgroundDefault = $permissionAppChip.Background
$script:chipTextDefault = $permissionAppText.Foreground
$noticeDot.Fill = New-Object System.Windows.Media.SolidColorBrush((New-AccentColor 255))
$noticeCard.BorderBrush = New-Object System.Windows.Media.SolidColorBrush((New-AccentColor 235))
if ($null -ne $noticeCard.Effect) { $noticeCard.Effect.Color = New-AccentColor 255 }
$targetFrame.BorderBrush = New-Object System.Windows.Media.SolidColorBrush((New-AccentColor 255))
$targetFrame.Effect.Color = New-AccentColor 255
$targetFrame.Effect.Opacity = 0.6
$script:clickPoint = $clickPoint
$clickPoint.Stroke = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(255, (New-LightChannel $accentR 0.7), (New-LightChannel $accentG 0.7), (New-LightChannel $accentB 0.7)))
$targetFlow.Stroke = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(255, $accentR, $accentG, $accentB))
$targetLabel.BorderBrush = New-Object System.Windows.Media.SolidColorBrush((New-AccentColor 120))
$targetLabel.BorderThickness = New-Object System.Windows.Thickness(1)
$targetPill.BorderBrush = New-Object System.Windows.Media.SolidColorBrush((New-AccentColor 210))
$targetPill.BorderThickness = New-Object System.Windows.Thickness(1)
$targetPillDot.Fill = New-Object System.Windows.Media.SolidColorBrush((New-AccentColor 255))

$script:app = New-Object System.Windows.Application
$script:pendingPermission = $null
$script:placeholder = '随时补充一条消息…'
$script:hideTimer = $null
# Window handle of the docked panel, so the status strip can stay glued to it.
$script:appHandle = 0
$script:bannerTimer = $null
$script:recording = $false
$script:silentTicks = 0
$script:voiceFolder = Join-Path $env:TEMP 'dsh-voice'
$script:hintSuffix = ''

$script:logPath = Join-Path $env:TEMP 'dsh-overlay.log'
function Write-Log([string]$text) {
    try {
        Add-Content -LiteralPath $script:logPath -Value ((Get-Date).ToString('HH:mm:ss.fff') + ' ' + $text) -Encoding UTF8
    } catch {
    }
}

function Send-Host($payload) {
    $script:output.WriteLine(($payload | ConvertTo-Json -Compress -Depth 6))
}

function Set-Brush([string]$color) {
    return [System.Windows.Media.BrushConverter]::new().ConvertFromString($color)
}

# The edge light means "operating this computer right now", so it has to leave
# the moment control stops - a short fade, never a lingering countdown.
# `$script:glowWanted` guards the fade's completion: a new turn can show the
# light again while the fade clock is still running, and that late callback
# must not collapse the window that was just lit.
#
# The breathing pulse is an animation, and an animation overrides a plain
# `$glowRoot.Opacity = 0`. Starting it at boot therefore painted the edge light
# while the glow was switched off, which read as a blue flash at the start of
# every turn. The pulse now runs only while the light is meant to be visible.
function Start-BandPulse {
    if ($null -eq $script:bandPulse) { return }
    foreach ($band in @($bandTop, $bandBottom, $bandLeft, $bandRight)) {
        if ($null -ne $band) { $band.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $script:bandPulse) }
    }
}

function Stop-BandPulse {
    foreach ($band in @($bandTop, $bandBottom, $bandLeft, $bandRight)) {
        if ($null -ne $band) {
            $band.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
            $band.Opacity = 1
        }
    }
}

function Set-GlowVisible([bool]$visible) {
    $script:glowWanted = $visible
    if ($visible) {
        $script:glow.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
        $script:glow.Opacity = 1
        $script:glow.Visibility = 'Visible'
        Start-BandPulse
        return
    }
    # 先让四条带子回到静止，再让整扇窗淡出；根容器不再参与呼吸。
    Stop-BandPulse
    if ($null -ne $glowRoot) {
        $glowRoot.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
        $glowRoot.Opacity = 1
    }
    if ($script:glow.Visibility -ne 'Visible') { return }
    try {
        $fade = New-Object System.Windows.Media.Animation.DoubleAnimation(1, 0, [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(300)))
        $fade.Add_Completed({
            if ($script:glowWanted) { return }
            $script:glow.Visibility = 'Collapsed'
            $script:glow.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
            $script:glow.Opacity = 1
        })
        $script:glow.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fade)
    } catch {
        $script:glow.Visibility = 'Collapsed'
    }
}

function Set-CardVisible([bool]$visible) {
    if ($visible) {
        $script:card.Visibility = 'Visible'
        Set-GlowVisible $true
    } else {
        $script:card.Visibility = 'Collapsed'
        Set-GlowVisible $false
    }
}

# The status strip is a separate window, so it does not inherit the docked panel's
# position. Follow the panel while the strip is visible: moving the panel (or the
# window manager changing its frame) used to leave the strip floating in mid-air.
function Place-Banner {
    if ($script:appHandle -le 0) { return }
    if (-not $script:banner.IsVisible) { return }
    $rect = New-Object 'OverlayWin32+RECT'
    if (-not [OverlayWin32]::GetWindowRect([IntPtr]$script:appHandle, [ref]$rect)) { return }
    $panelWidth = $rect.Right - $rect.Left
    if ($panelWidth -le 1) { return }
    $script:banner.Left = $rect.Left + [Math]::Round(($panelWidth - $script:banner.ActualWidth) / 2)
    $script:banner.Top = $rect.Top + 40
}

function Start-BannerFollow {
    if ($null -ne $script:bannerTimer) { return }
    $script:bannerTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:bannerTimer.Interval = [TimeSpan]::FromMilliseconds(250)
    $script:bannerTimer.Add_Tick({
        try {
            Place-Banner
            # The panel is re-raised topmost by every action, which puts the strip
            # underneath it within one click. Re-raising on each follow tick keeps
            # the status readable for as long as it is shown, at no visible cost.
            if ($script:banner.IsVisible) { Bring-BannerToFront }
        } catch { }
    })
    $script:bannerTimer.Start()
}

# The docked panel is topmost, so a plain Show() can leave the strip behind it.
function Bring-BannerToFront {
    try {
        $helper = New-Object System.Windows.Interop.WindowInteropHelper($script:banner)
        if ($helper.Handle -ne [IntPtr]::Zero) {
            [OverlayWin32]::SetWindowPos($helper.Handle, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010) | Out-Null
        }
    } catch { }
}

function Stop-BannerFollow {
    if ($null -eq $script:bannerTimer) { return }
    $script:bannerTimer.Stop()
    $script:bannerTimer = $null
}

function Set-Status([string]$text) {
    $statusText.Foreground = Set-Brush '#A9A9B4'
    $statusText.Text = $text
}

function Add-Row {
    param(
        [string]$text,
        [string]$kind = 'input',
        [string]$thumbPath = '',
        # Same-series rows replace each other instead of appending: a ticker that
        # keeps changing in one place instead of one row per mouse movement.
        [string]$merge = ''
    )

    # Consecutive identical tool or capture rows collapse into one counted line,
    # so a long run of one command does not bury the rest of the feed.
    $collapseKey = if ($merge -ne '') { 'merge|' + $merge } else { $kind + '|' + $text }
    if ($thumbPath -eq '' -and $null -ne $script:lastRowLabel -and $script:lastRowKey -eq $collapseKey -and ($merge -ne '' -or $kind -eq 'tool' -or $kind -eq 'capture')) {
        $script:lastRowCount++
        # A batch step row changes its text every step, so a count would read as
        # "第 8 步 ×8"; only the tickers that repeat one action count.
        $suffix = if ($merge -eq 'step') { '' } else { ' ×' + $script:lastRowCount }
        $script:lastRowLabel.Text = $text + $suffix
        $feedScroll.ScrollToEnd()
        return
    }
    $row = New-Object System.Windows.Controls.Grid
    $row.Margin = New-Object System.Windows.Thickness(0, 0, 0, 8)

    $colDot = New-Object System.Windows.Controls.ColumnDefinition
    $colDot.Width = [System.Windows.GridLength]::new(14)
    $colText = New-Object System.Windows.Controls.ColumnDefinition
    $colText.Width = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
    $colThumb = New-Object System.Windows.Controls.ColumnDefinition
    $colThumb.Width = [System.Windows.GridLength]::Auto
    [void]$row.ColumnDefinitions.Add($colDot)
    [void]$row.ColumnDefinitions.Add($colText)
    [void]$row.ColumnDefinitions.Add($colThumb)

    $dot = New-Object System.Windows.Shapes.Ellipse
    $dot.Width = 6
    $dot.Height = 6
    $dot.VerticalAlignment = 'Top'
    $dot.Margin = New-Object System.Windows.Thickness(0, 5, 0, 0)
    $color = $script:colors[$kind]
    if ($null -eq $color) { $color = '#A9A9B4' }
    $dot.Fill = Set-Brush $color
    [System.Windows.Controls.Grid]::SetColumn($dot, 0)
    [void]$row.Children.Add($dot)

    $label = New-Object System.Windows.Controls.TextBlock
    $label.Text = $text
    $label.TextWrapping = 'Wrap'
    $label.FontSize = 11.5
    $label.LineHeight = 16
    if ($kind -eq 'assistant') { $label.FontSize = 11.5 }
    $label.Foreground = Set-Brush $script:colors.detail
    $label.Margin = New-Object System.Windows.Thickness(0, 0, 8, 0)
    [System.Windows.Controls.Grid]::SetColumn($label, 1)
    [void]$row.Children.Add($label)

    if ($thumbPath -and (Test-Path -LiteralPath $thumbPath)) {
        try {
            $image = New-Object System.Windows.Controls.Image
            $image.Width = 56
            $image.Height = 38
            $image.Stretch = 'UniformToFill'
            $bitmap = New-Object System.Windows.Media.Imaging.BitmapImage
            $bitmap.BeginInit()
            $bitmap.CacheOption = 'OnLoad'
            $bitmap.DecodePixelWidth = 112
            $bitmap.UriSource = [System.Uri]::new($thumbPath)
            $bitmap.EndInit()
            $image.Source = $bitmap
            $frame = New-Object System.Windows.Controls.Border
            $frame.CornerRadius = [System.Windows.CornerRadius]::new(5)
            $frame.ClipToBounds = $true
            $frame.BorderThickness = New-Object System.Windows.Thickness(1)
            $frame.BorderBrush = Set-Brush '#33FFFFFF'
            $frame.Child = $image
            $frame.VerticalAlignment = 'Top'
            [System.Windows.Controls.Grid]::SetColumn($frame, 2)
            [void]$row.Children.Add($frame)
        } catch {
            # A missing or unreadable preview must never break the action feed.
        }
        Remove-Item -LiteralPath $thumbPath -Force -ErrorAction SilentlyContinue
    }

    [void]$feed.Children.Add($row)
    while ($feed.Children.Count -gt 40) { $feed.Children.RemoveAt(0) }
    $script:lastRowKey = $collapseKey
    $script:lastRowLabel = $label
    $script:lastRowCount = 1
    $feedScroll.ScrollToEnd()
}

function Reset-PermissionStyle {
    $permissionPanel.Background = $script:panelBackgroundDefault
    $permissionPanel.BorderBrush = $script:panelBorderDefault
    $permissionTitle.Foreground = $script:panelTitleDefault
    $allowButton.Background = $script:accentSolid
    $allowButton.Foreground = $whiteBrush
    $permissionAppChip.Background = $script:chipBackgroundDefault
    $permissionAppText.Foreground = $script:chipTextDefault
    $allowButton.IsEnabled = $true
    if ($script:dangerTimer) {
        $script:dangerTimer.Stop()
        $script:dangerTimer = $null
    }
}

function Start-DangerCountdown {
    $script:dangerRemaining = 3
    $allowButton.Content = '确认执行 (3)'
    $allowButton.IsEnabled = $false
    $script:dangerTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:dangerTimer.Interval = [TimeSpan]::FromSeconds(1)
    $script:dangerTimer.Add_Tick({
        $script:dangerRemaining = $script:dangerRemaining - 1
        if ($script:dangerRemaining -le 0) {
            $script:dangerTimer.Stop()
            $script:dangerTimer = $null
            $allowButton.Content = '确认执行'
            $allowButton.IsEnabled = $true
        } else {
            $allowButton.Content = '确认执行 (' + $script:dangerRemaining + ')'
        }
    })
    $script:dangerTimer.Start()
}

function Apply-DangerStyle {
    $permissionPanel.Background = Set-Brush '#2B1717'
    $permissionPanel.BorderBrush = Set-Brush '#80FF6B6B'
    $permissionTitle.Foreground = Set-Brush '#FFBDBD'
    $permissionAppChip.Background = Set-Brush '#4DFF6B6B'
    $permissionAppText.Foreground = Set-Brush '#FFD0D0'
    $allowButton.Background = Set-Brush '#E5484D'
    $allowButton.Foreground = Set-Brush '#FFFFFF'
    Start-DangerCountdown
}
function Show-Permission($payload) {
    $script:pendingPermission = [string]$payload.id
    $permissionTitle.Text = [string]$payload.title
    $permissionDetail.Text = [string]$payload.detail
    $risk = [string]$payload.risk
    if ($risk.Length -gt 0) {
        $permissionRisk.Text = $risk
        $permissionRisk.Visibility = 'Visible'
    } else {
        $permissionRisk.Visibility = 'Collapsed'
    }
    if ($payload.app) {
        $permissionAppText.Text = [string]$payload.app
        $permissionAppChip.Visibility = 'Visible'
    } else {
        $permissionAppChip.Visibility = 'Collapsed'
    }
    Reset-PermissionStyle
    $permissionPanel.Visibility = 'Visible'
    if ($payload.danger -eq $true) {
        Apply-DangerStyle
        $statusText.Foreground = Set-Brush '#FF8A8A'
        $statusText.Text = '危险操作，需要你确认'
    } else {
        $statusText.Foreground = Set-Brush '#FFB27A'
        $statusText.Text = '需要你的确认'
    }
}

function Hide-Permission {
    $script:pendingPermission = $null
    $permissionPanel.Visibility = 'Collapsed'
    Reset-PermissionStyle
}

function Complete-Permission([string]$decision) {
    if ($null -eq $script:pendingPermission) { return }
    Send-Host @{ type = 'permission'; id = $script:pendingPermission; decision = $decision }
    $script:pendingPermission = $null
    $permissionPanel.Visibility = 'Collapsed'
    if ($decision -eq 'allow') { Set-Status '已允许，继续操作…' } else { Set-Status '已拒绝，正在停止…' }
}

function Send-Reply([bool]$immediate = $false) {
    $text = $replyBox.Text
    if ([string]::IsNullOrWhiteSpace($text)) { return }
    if ($text -eq $script:placeholder) { return }
    $replyBox.Text = ''
    $replyBox.Foreground = Set-Brush '#EDEDF2'
    Send-Host @{ type = 'reply'; text = $text; immediate = $immediate }
    if ($immediate) { Set-Status '已发送，下一步就能看到' } else { Set-Status '已排队，本轮结束后自动发送' }
}

function Update-Hint {
    $hintText.Text = 'Enter 排队到本轮结束后发送 · Ctrl+Enter 立即发送' + $script:hintSuffix
}
function Reset-ReplyPlaceholder {
    $replyBox.Text = $script:placeholder
    $replyBox.Foreground = Set-Brush '#6E6E7A'
}

function Handle-Message($line) {
    if ([string]::IsNullOrWhiteSpace($line)) { return }
    $message = $null
    try { $message = $line | ConvertFrom-Json } catch { return }

    switch ([string]$message.type) {
        'show' {
            # The caller decides both halves now: the card can be wanted while the
            # edge glow is switched off. Showing the card no longer implies "light
            # the screen", which is what made `effectGlow: false` look ignored.
            if ($message.card -eq $false) { break }
            Write-Log ('show glow=' + $message.glow)
            if ($script:stopTimer) { $script:stopTimer.Stop(); $script:stopTimer = $null }
            if ($script:hideTimer) { $script:hideTimer.Stop(); $script:hideTimer = $null }
            if ($message.title) { $titleText.Text = [string]$message.title }
            if ($message.reset -eq $true) {
                $progressTrack.Visibility = 'Collapsed'
                $feed.Children.Clear()
                $script:lastRowKey = ''
                $script:lastRowLabel = $null
                Hide-Permission
                $liveText.Visibility = 'Collapsed'
                $liveText.Text = ''
            }
            if ($message.status) { Set-Status ([string]$message.status) }
            $script:card.Visibility = 'Visible'
            $script:card.Opacity = 1
            if ($message.glow -ne $false) { Set-GlowVisible $true }
        }
        'hide' { Write-Log 'hide'; Set-CardVisible $false }
        'card-hide' { $script:card.Visibility = 'Collapsed' }
        'policy' {
            # The Settings page owns these switches. A live change must reach the
            # screen immediately: the overlay keeps showing whatever it was last
            # told, which made every switch look dead until the next turn.
            Write-Log ('policy glow=' + $message.glow + ' card=' + $message.card + ' banner=' + $message.banner + ' preview=' + $message.preview + ' target=' + $message.target + ' point=' + $message.clickPoint)
            if ($message.glow -eq $false) {
                Set-GlowVisible $false
            } elseif ($message.glow -eq $true -and ($script:card.Visibility -eq 'Visible' -or $message.card -eq $false)) {
                # Control is live again, so the edge may light up. When the card is
                # switched off the overlay is running for the light alone: turning
                # 「蓝边」 back on must not wait for the next turn.
                Set-GlowVisible $true
            }
            if ($message.card -eq $false) { $script:card.Visibility = 'Collapsed' }
            if ($message.banner -eq $false) { Stop-BannerFollow; $script:banner.Hide() }
            if ($message.preview -eq $false) {
                Hide-Preview
            }
            if ($message.target -eq $false) {
                $targetFrame.Visibility = 'Collapsed'
                $targetFlow.Visibility = 'Collapsed'
                $targetLabel.Visibility = 'Collapsed'
                $targetPill.Visibility = 'Collapsed'
            }
            if ($message.clickPoint -eq $false) { $clickPoint.Visibility = 'Collapsed' }
            Write-Log ('policy done cardVis=' + $script:card.Visibility + ' glowVis=' + $script:glow.Visibility + ' glowOp=' + $script:glow.Opacity + ' rootOp=' + $glowRoot.Opacity)
        }
        'glow-dock' {
            # The docked window owns the top-right corner, so the edge light
            # steps back: the top band stops before it and the right band
            # starts below it.
            $dockX = [double]$message.x
            $dockY = [double]$message.y
            $dockWidth = [double]$message.width
            $dockHeight = [double]$message.height
            $bandTop.Width = [Math]::Max(0, $dockX - 12)
            $bandTop.HorizontalAlignment = 'Left'
            $bandRight.Height = [Math]::Max(0, $virtualHeight - ($dockY + $dockHeight) - 12)
            $bandRight.VerticalAlignment = 'Bottom'
        }
        'glow-dock-clear' {
            $bandTop.ClearValue([System.Windows.FrameworkElement]::WidthProperty)
            $bandTop.HorizontalAlignment = 'Stretch'
            $bandRight.ClearValue([System.Windows.FrameworkElement]::HeightProperty)
            $bandRight.VerticalAlignment = 'Stretch'
        }
        'banner' {
            $bannerText.Text = [string]$message.text
            $script:banner.Show()
            $script:banner.UpdateLayout()
            Set-ClickThrough $script:banner
            $bannerCard.Opacity = 1
            $bannerX = [double]$message.x
            $bannerY = [double]$message.y
            $script:banner.Left = $bannerX + [Math]::Round(($message.width - $script:banner.ActualWidth) / 2)
            $script:banner.Top = $bannerY + 40
            # Every action re-raises the docked panel, so the strip has to be
            # pushed to the very top again or it ends up underneath the panel
            # after the first click of the turn.
            Bring-BannerToFront
            Start-BannerFollow
            Write-Log ('banner text=' + $message.text + ' xy=' + $message.x + ',' + $message.y + ' w=' + $message.width + ' actual=' + $script:banner.ActualWidth + ' at=' + $script:banner.Left + ',' + $script:banner.Top + ' vis=' + $script:banner.IsVisible)
        }
        'banner-hide' {
            Stop-BannerFollow
            $script:banner.Hide()
        }
        'glow-only' {
            if ($script:stopTimer) { $script:stopTimer.Stop(); $script:stopTimer = $null }
            if ($script:hideTimer) { $script:hideTimer.Stop(); $script:hideTimer = $null }
            $script:card.Visibility = 'Collapsed'
            Set-GlowVisible $true
            # This process owns the topmost glow, so it must put the docked
            # window back on top; a call from another process is undone by the
            # next time this window is shown. Topmost is what keeps the panel
            # visible above whatever application the agent is clicking.
            if ($null -ne $message.app -and [long]$message.app -gt 0) {
                $script:appHandle = [long]$message.app
                [OverlayWin32]::SetWindowPos([IntPtr][long]$message.app, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010) | Out-Null
                Place-Banner
            }
            Write-Log ('glow-only vis=' + $script:glow.Visibility + ' op=' + $script:glow.Opacity + ' xy=' + $script:glow.Left + ',' + $script:glow.Top + ' size=' + $script:glow.Width + 'x' + $script:glow.Height + ' bandTop=' + $bandTop.Opacity + ' bandRight=' + $bandRight.Opacity)
        }
        'status' { Set-Status ([string]$message.text) }
        'action' {
            $thumb = ''
            if ($message.thumb) { $thumb = [string]$message.thumb }
            $mergeKey = ''
            if ($message.merge) { $mergeKey = [string]$message.merge }
            Add-Row -text ([string]$message.text) -kind ([string]$message.kind) -thumbPath $thumb -merge $mergeKey
        }
        'target' {
            # 真正的窗口跟踪来了：撤掉「点一下就冒出来」的临时标牌计时。
            if ($null -ne $script:pillTtlTimer) {
                $script:pillTtlTimer.Stop()
                $script:pillTtlTimer = $null
            }
            $targetWidth = [double]$message.width
            $targetHeight = [double]$message.height
            # 常驻标牌：不管边框收没收（被盖住/最小化），这块都写着"正在操作谁"。
            $pillCaption = [string]$message.label
            if ([string]::IsNullOrWhiteSpace($pillCaption)) {
                $targetPill.Visibility = 'Collapsed'
                $script:pillGrip.Hide()
            } else {
                $targetPillText.Text = $pillCaption
                $targetPill.Visibility = 'Visible'
                Set-PillPlacement ([string]$message.pillCorner)
            }
            if ($targetWidth -le 1 -or $targetHeight -le 1) {
                $targetFrame.Visibility = 'Collapsed'
                $targetFlow.Visibility = 'Collapsed'
                $targetLabel.Visibility = 'Collapsed'
            } elseif ($message.covered -eq $true) {
                # 目标窗口被别的窗口压住时，这条画在它上面的边框会浮到最上层——
                # 看起来像被压住的窗口反而在前面。先收起来，等它重新露出来再画。
                $targetFrame.Visibility = 'Collapsed'
                $targetFlow.Visibility = 'Collapsed'
                $targetLabel.Visibility = 'Collapsed'
            } else {
                $targetX = [double]$message.x - $virtualLeft
                $targetY = [double]$message.y - $virtualTop
                $targetFrame.Width = $targetWidth
                $targetFrame.Height = $targetHeight
                $targetFrame.Margin = [System.Windows.Thickness]::new($targetX, $targetY, 0, 0)
                $targetFrame.Visibility = 'Visible'
                $targetFlow.Margin = [System.Windows.Thickness]::new($targetX + 1, $targetY + 1, 0, 0)
                $targetFlow.Data = New-Object System.Windows.Media.RectangleGeometry([System.Windows.Rect]::new(0, 0, [Math]::Max(4, $targetWidth - 2), [Math]::Max(4, $targetHeight - 2)), 8, 8)
                $targetFlow.Visibility = 'Visible'
                $caption = [string]$message.label
                if ([string]::IsNullOrWhiteSpace($caption)) {
                    $targetLabel.Visibility = 'Collapsed'
                } else {
                    $targetLabelText.Text = $caption
                    $targetLabel.Visibility = 'Visible'
                    $targetLabel.Margin = [System.Windows.Thickness]::new([Math]::Max(0, $targetX), [Math]::Max(0, $targetY - 32), 0, 0)
                }
            }
        }
        'target-pill' {
            # 纯坐标点击：没有窗口可跟踪，只在动作后露一下"刚才点的是哪个窗口"。
            $pillCaption = [string]$message.label
            if ([string]::IsNullOrWhiteSpace($pillCaption)) { break }
            $targetPillText.Text = $pillCaption
            $targetPill.Visibility = 'Visible'
            Set-PillPlacement ([string]$message.pillCorner)
            $ttl = 4000
            if ([int]$message.ttl -gt 0) { $ttl = [int]$message.ttl }
            if ($null -ne $script:pillTtlTimer) { $script:pillTtlTimer.Stop() }
            $script:pillTtlTimer = New-Object System.Windows.Threading.DispatcherTimer
            $script:pillTtlTimer.Interval = [TimeSpan]::FromMilliseconds($ttl)
            $script:pillTtlTimer.Add_Tick({
                $script:pillTtlTimer.Stop()
                $script:pillTtlTimer = $null
                $targetPill.Visibility = 'Collapsed'
                $script:pillGrip.Hide()
            })
            $script:pillTtlTimer.Start()
        }
        'progress' {
            $progressLabel = [string]$message.label
            $progressStep = [int]$message.step
            $progressTotal = [int]$message.total
            if ($progressTotal -gt 0) {
                $ratio = [Math]::Min([Math]::Max($progressStep / [double]$progressTotal, 0), 1)
                $progressTrack.Visibility = 'Visible'
                $progressScale.ScaleX = $ratio
                Set-Status ("[$progressStep/$progressTotal] " + $progressLabel)
            } else {
                $progressTrack.Visibility = 'Collapsed'
                Set-Status $progressLabel
            }
        }
        'point' {
            $pointX = [double]$message.x
            $pointY = [double]$message.y
            $clickPoint.Margin = [System.Windows.Thickness]::new($pointX - 17, $pointY - 17, 0, 0)
            $clickPoint.Opacity = 1
            $clickPoint.Visibility = 'Visible'
            $fade = New-Object System.Windows.Media.Animation.DoubleAnimation(1, 0, [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(620)))
            $clickPoint.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fade)
            if ($script:pointTimer) { $script:pointTimer.Stop() }
            $script:pointTimer = New-Object System.Windows.Threading.DispatcherTimer
            $script:pointTimer.Interval = [TimeSpan]::FromMilliseconds(640)
            $script:pointTimer.Add_Tick({
                $script:pointTimer.Stop()
                $script:pointTimer = $null
                $clickPoint.Visibility = 'Collapsed'
            })
            $script:pointTimer.Start()
        }
        'focus-input' {
            # Never activate the card here: it would become the foreground window
            # and swallow the input the agent is about to send elsewhere.
            [void]$replyBox.Focus()
        }
        'voice-text' {
            Append-ReplyText ([string]$message.text)
            Set-Status '语音已转成文字'
        }
        'voice-error' {
            Set-Status ('语音识别失败：' + [string]$message.message)
        }
        'target-clear' {
            if ($null -ne $script:pillTtlTimer) { $script:pillTtlTimer.Stop(); $script:pillTtlTimer = $null }
            $targetFrame.Visibility = 'Collapsed'
            $targetFlow.Visibility = 'Collapsed'
            $targetLabel.Visibility = 'Collapsed'
            $targetPill.Visibility = 'Collapsed'
            $script:pillGrip.Hide()
        }
        'live' {
            $lineText = [string]$message.text
            if ([string]::IsNullOrWhiteSpace($lineText)) {
                $liveText.Text = ''
                $liveText.Visibility = 'Collapsed'
            } else {
                $liveText.Text = ('正在输出：' + $lineText)
                $liveText.Visibility = 'Visible'
            }
        }
        'live-clear' {
            $liveText.Text = ''
            $liveText.Visibility = 'Collapsed'
        }
        'notice' { Show-Notice $message }
        'preview' { Show-Preview $message }
        'preview-hide' { Hide-Preview }
        'permission' { Show-Permission $message }
        'permission-clear' { Hide-Permission }
        'done' {
            Write-Log ('done text=' + $message.text)
            Stop-VoiceCapture '语音输入已结束'
            Set-Status ([string]$message.text)
            Hide-Permission
            $liveText.Visibility = 'Collapsed'
            Hide-Preview
            # Control is over: the light goes now. The card may stay a moment so
            # the last line is readable, but nothing on screen should still say
            # "DeepSeek is driving your computer".
            Set-GlowVisible $false
            if ($script:hideTimer) { $script:hideTimer.Stop() }
            $script:hideTimer = New-Object System.Windows.Threading.DispatcherTimer
            $script:hideTimer.Interval = [TimeSpan]::FromSeconds(3)
            $script:hideTimer.Add_Tick({
                $script:hideTimer.Stop()
                $script:card.Visibility = 'Collapsed'
            })
            $script:hideTimer.Start()
        }
        'stop-ack' { Set-Status ([string]$message.text) }
        'quit' { $script:app.Shutdown() }
    }

    if ($Dump -ne '') {
        try {
            [System.IO.File]::AppendAllText($Dump, ('{0} rows={1} height={2}' -f $message.type, $feed.Children.Count, [int]$script:card.ActualHeight) + "`r`n")
        } catch { }
    }
}

# Raise any overlay window above the docked panel, which is itself topmost.
function Bring-ToFront([System.Windows.Window]$window) {
    try {
        $helper = New-Object System.Windows.Interop.WindowInteropHelper($window)
        if ($helper.Handle -ne [IntPtr]::Zero) {
            [OverlayWin32]::SetWindowPos($helper.Handle, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010) | Out-Null
        }
    } catch { }
}

# Keep the grab handle on the preview's top-right corner.
function Place-Grip {
    if ($script:preview.Visibility -ne 'Visible') { return }
    $width = $script:preview.ActualWidth
    if ($width -le 0) { $width = 334 }
    $script:grip.Left = [Math]::Round($script:preview.Left + $width - 40)
    $script:grip.Top = [Math]::Round($script:preview.Top + 6)
}

function Hide-Preview {
    if ($null -ne $script:previewTimer) { $script:previewTimer.Stop(); $script:previewTimer = $null }
    $script:preview.Hide()
    $script:grip.Hide()
}

# Drag the preview by its handle. The handle is the only interactive pixel of the
# preview: the picture stays click-through, and its position is remembered so the
# next free-placed preview returns there.
$script:grip.Add_MouseLeftButtonDown({
    $script:gripDrag = $true
    $cursor = [System.Windows.Forms.Cursor]::Position
    $script:gripStartCursor = [System.Windows.Point]::new($cursor.X, $cursor.Y)
    $script:gripStartLeft = $script:preview.Left
    $script:gripStartTop = $script:preview.Top
    [void]$script:grip.CaptureMouse()
})
$script:grip.Add_MouseMove({
    if (-not $script:gripDrag) { return }
    $cursor = [System.Windows.Forms.Cursor]::Position
    $dx = ($cursor.X - $script:gripStartCursor.X) / $script:dpiScale
    $dy = ($cursor.Y - $script:gripStartCursor.Y) / $script:dpiScale
    $width = $script:preview.ActualWidth
    $height = $script:preview.ActualHeight
    $maxLeft = $virtualLeft + $virtualWidth - $width - 8
    $maxTop = $virtualTop + $virtualHeight - $height - 8
    $script:preview.Left = [Math]::Min([Math]::Max($script:gripStartLeft + $dx, $virtualLeft + 8), $maxLeft)
    $script:preview.Top = [Math]::Min([Math]::Max($script:gripStartTop + $dy, $virtualTop + 8), $maxTop)
    Place-Grip
})
$script:grip.Add_MouseLeftButtonUp({
    if (-not $script:gripDrag) { return }
    $script:gripDrag = $false
    [void]$script:grip.ReleaseMouseCapture()
    $x = [int][Math]::Round($script:preview.Left)
    $y = [int][Math]::Round($script:preview.Top)
    try {
        [System.IO.File]::WriteAllText($script:previewPosPath, ('{"x":' + $x + ',"y":' + $y + '}'), [System.Text.UTF8Encoding]::new($false))
    } catch { }
    Send-Host ([pscustomobject]@{ type = 'preview-moved'; x = $x; y = $y })
    Write-Log ('preview moved xy=' + $x + ',' + $y)
})

# 目标标牌的位置：默认顶部居中，也可以选四角；custom = 拖到哪记哪。
$script:pillPosPath = Join-Path $env:TEMP 'dsh-computer-use-pillpos.json'
$script:pillCorner = 'topcenter'
$script:pillCustomX = 24
$script:pillCustomY = 24
try {
    if (Test-Path -LiteralPath $script:pillPosPath) {
        $savedPill = Get-Content -LiteralPath $script:pillPosPath -Raw | ConvertFrom-Json
        if ($null -ne $savedPill.x -and $null -ne $savedPill.y) {
            $script:pillCustomX = [int]$savedPill.x
            $script:pillCustomY = [int]$savedPill.y
        }
    }
} catch { }

$pillGripXaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="DSH computer use pill grip"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False" Topmost="True" ShowActivated="False"
        ResizeMode="NoResize" Width="26" Height="22" Cursor="SizeAll">
  <Border CornerRadius="6" Background="#F20F1014" BorderThickness="1" BorderBrush="#4D2F7DF6">
    <TextBlock Text="⣿" FontSize="11" Foreground="#8FB6F5" HorizontalAlignment="Center" VerticalAlignment="Center"/>
  </Border>
</Window>
'@
$script:pillGrip = [System.Windows.Markup.XamlReader]::Parse($pillGripXaml)
$script:pillGripDrag = $false
$script:pillGripStartCursor = [System.Windows.Point]::new(0, 0)
$script:pillGripStartX = 0
$script:pillGripStartY = 0
# 把手跟鼠标走：靠近标牌就出现，移开 1.2 秒后收起。浮层整体是点击穿透的，
# 收不到 MouseMove，只能定时读一次真实光标位置来判"人在不在附近"。
$script:pillGripNearAt = [DateTime]::MinValue
$script:pillHoverTimer = $null
# 纯坐标点击时那块"刚点了哪个窗口"的临时标牌，到点自己收。
$script:pillTtlTimer = $null

function Update-PillHover {
    if ($script:pillCorner -ne 'custom') {
        if ($script:pillGrip.Visibility -eq 'Visible') { $script:pillGrip.Hide() }
        return
    }
    if ($targetPill.Visibility -ne 'Visible') {
        if ($script:pillGrip.Visibility -eq 'Visible') { $script:pillGrip.Hide() }
        return
    }
    $cursor = [System.Windows.Forms.Cursor]::Position
    $left = $virtualLeft + [int][Math]::Round($targetPill.Margin.Left)
    $top = $virtualTop + [int][Math]::Round($targetPill.Margin.Top)
    $width = [Math]::Max(80, [int]$targetPill.ActualWidth)
    $height = [Math]::Max(24, [int]$targetPill.ActualHeight)
    # 左边多留 44 px：把手本身就挂在标牌左侧，鼠标往那儿挪不能算"离开"。
    $near = ($cursor.X -ge ($left - 44)) -and ($cursor.X -le ($left + $width + 16)) `
        -and ($cursor.Y -ge ($top - 20)) -and ($cursor.Y -le ($top + $height + 20))
    if ($near) { $script:pillGripNearAt = [DateTime]::UtcNow }
    $recent = (([DateTime]::UtcNow) - $script:pillGripNearAt).TotalSeconds -lt 1.2
    if ($near -or $recent) {
        if ($script:pillGripDrag) { return }
        Update-PillGripPosition
        if ($script:pillGrip.Visibility -ne 'Visible') { $script:pillGrip.Show() }
    } elseif ($script:pillGrip.Visibility -eq 'Visible') {
        $script:pillGrip.Hide()
    }
}

function Update-PillGripPosition {
    $script:pillGrip.Left = [Math]::Round([Math]::Max($virtualLeft + 8, $script:pillCustomX - 34))
    $script:pillGrip.Top = [Math]::Round([Math]::Max($virtualTop + 8, $script:pillCustomY + 3))
}

function Update-PillGrip {
    if (($script:pillCorner -ne 'custom') -or ($targetPill.Visibility -ne 'Visible')) {
        $script:pillGrip.Hide()
        return
    }
    Update-PillGripPosition
}

function Set-PillPlacement([string]$corner) {
    if ([string]::IsNullOrWhiteSpace($corner)) { $corner = 'topcenter' }
    $script:pillCorner = $corner
    $targetPill.HorizontalAlignment = 'Center'
    $targetPill.VerticalAlignment = 'Top'
    $margin = [System.Windows.Thickness]::new(0, 12, 0, 0)
    switch ($corner) {
        'topleft' {
            $targetPill.HorizontalAlignment = 'Left'
            $margin = [System.Windows.Thickness]::new(12, 12, 0, 0)
        }
        'topright' {
            $targetPill.HorizontalAlignment = 'Right'
            $margin = [System.Windows.Thickness]::new(0, 12, 12, 0)
        }
        'bottomleft' {
            $targetPill.HorizontalAlignment = 'Left'
            $targetPill.VerticalAlignment = 'Bottom'
            $margin = [System.Windows.Thickness]::new(12, 0, 0, 12)
        }
        'bottomright' {
            $targetPill.HorizontalAlignment = 'Right'
            $targetPill.VerticalAlignment = 'Bottom'
            $margin = [System.Windows.Thickness]::new(0, 0, 12, 12)
        }
        'custom' {
            $targetPill.HorizontalAlignment = 'Left'
            $margin = [System.Windows.Thickness]::new(
                [Math]::Max(0, $script:pillCustomX - $virtualLeft),
                [Math]::Max(0, $script:pillCustomY - $virtualTop), 0, 0)
        }
    }
    $targetPill.Margin = $margin
    Update-PillGrip
}

$script:pillGrip.Add_MouseLeftButtonDown({
    $script:pillGripDrag = $true
    $cursor = [System.Windows.Forms.Cursor]::Position
    $script:pillGripStartCursor = [System.Windows.Point]::new($cursor.X, $cursor.Y)
    $script:pillGripStartX = $script:pillCustomX
    $script:pillGripStartY = $script:pillCustomY
    [void]$script:pillGrip.CaptureMouse()
})
$script:pillGrip.Add_MouseMove({
    if (-not $script:pillGripDrag) { return }
    $cursor = [System.Windows.Forms.Cursor]::Position
    $dx = ($cursor.X - $script:pillGripStartCursor.X) / $script:dpiScale
    $dy = ($cursor.Y - $script:pillGripStartCursor.Y) / $script:dpiScale
    $script:pillCustomX = [int][Math]::Min([Math]::Max($script:pillGripStartX + $dx, $virtualLeft + 8), $virtualLeft + $virtualWidth - 140)
    $script:pillCustomY = [int][Math]::Min([Math]::Max($script:pillGripStartY + $dy, $virtualTop + 8), $virtualTop + $virtualHeight - 44)
    $targetPill.Margin = [System.Windows.Thickness]::new(
        [Math]::Max(0, $script:pillCustomX - $virtualLeft),
        [Math]::Max(0, $script:pillCustomY - $virtualTop), 0, 0)
    Update-PillGrip
})
$script:pillGrip.Add_MouseLeftButtonUp({
    if (-not $script:pillGripDrag) { return }
    $script:pillGripDrag = $false
    [void]$script:pillGrip.ReleaseMouseCapture()
    try {
        [System.IO.File]::WriteAllText($script:pillPosPath, ('{"x":' + $script:pillCustomX + ',"y":' + $script:pillCustomY + '}'), [System.Text.UTF8Encoding]::new($false))
    } catch { }
    Write-Log ('pill moved xy=' + $script:pillCustomX + ',' + $script:pillCustomY)
    # 松手后不立刻收：鼠标还在附近，留着让人可以接着微调；离开 1.2 秒自然收。
    $script:pillGripNearAt = [DateTime]::UtcNow
})

# Show one captured frame beside the docked panel, then fade it away. The file is
# read with BitmapCacheOption.OnLoad so the caller may delete it straight after.
function Show-Preview($payload) {
    $path = [string]$payload.path
    if ($path.Length -eq 0 -or -not (Test-Path -LiteralPath $path)) { return }
    try {
        $bitmap = New-Object System.Windows.Media.Imaging.BitmapImage
        $bitmap.BeginInit()
        $bitmap.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
        $bitmap.UriSource = [Uri]::new($path)
        $bitmap.EndInit()
        $previewImage.Source = $bitmap
    } catch { return }
    if ($null -ne $payload.caption) { $previewCaption.Text = [string]$payload.caption }
    $script:preview.Show()
    Set-ClickThrough $script:preview
    $script:preview.UpdateLayout()
    if ([string]$payload.follow -eq 'card') {
        # Hug the floating card: left if there is room, otherwise right, always
        # inside the virtual desktop. The overlay owns the card, so this stays
        # correct after the card is resized.
        $pw = $script:preview.ActualWidth
        $ph = $script:preview.ActualHeight
        $gap = 12
        $left = $script:card.Left - $pw - $gap
        if ($left -lt $virtualLeft + 8) { $left = $script:card.Left + $script:card.ActualWidth + $gap }
        if ($left + $pw -gt $virtualLeft + $virtualWidth - 8) { $left = $virtualLeft + $virtualWidth - $pw - 8 }
        if ($left -lt $virtualLeft + 8) { $left = $virtualLeft + 8 }
        $top = $script:card.Top + $gap
        if ($top + $ph -gt $virtualTop + $virtualHeight - 8) { $top = $virtualTop + $virtualHeight - $ph - 8 }
        if ($top -lt $virtualTop + 8) { $top = $virtualTop + 8 }
        $script:preview.Left = $left
        $script:preview.Top = $top
    } else {
        if ($null -ne $payload.x) { $script:preview.Left = [double]$payload.x }
        if ($null -ne $payload.y) { $script:preview.Top = [double]$payload.y }
    }
    Bring-ToFront $script:preview
    if ([string]$payload.follow -eq 'card') {
        # Glued to the card: nothing to drag, the card owns the position.
        $script:grip.Hide()
    } else {
        Place-Grip
        $script:grip.Show()
        Bring-ToFront $script:grip
    }
    if ($null -ne $script:previewTimer) { $script:previewTimer.Stop(); $script:previewTimer = $null }
    $milliseconds = 4000
    if ($null -ne $payload.ms) { $milliseconds = [int]$payload.ms }
    $script:previewTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:previewTimer.Interval = [TimeSpan]::FromMilliseconds([Math]::Max(600, $milliseconds))
    $script:previewTimer.Add_Tick({
        $script:previewTimer.Stop()
        $script:preview.Hide()
        $script:grip.Hide()
    })
    $script:previewTimer.Start()
    Write-Log ('preview xy=' + $script:preview.Left + ',' + $script:preview.Top + ' size=' + $script:preview.ActualWidth + 'x' + $script:preview.ActualHeight)
}

function Show-Notice($payload) {    $seconds = $NoticeSeconds
    if ($null -ne $payload.seconds -and [int]$payload.seconds -gt 0) { $seconds = [int]$payload.seconds }
    if ($payload.title) { $noticeTitle.Text = [string]$payload.title }
    # Only the sentence is shown now: the detail line and the sweep bar were the
    # first thing the user asked to drop. The breathing dot carries "live".

    $script:notice.Show()
    $script:notice.UpdateLayout()
    Set-ClickThrough $script:notice
    $script:notice.Left = $virtualLeft + [Math]::Round(($virtualWidth - $script:notice.ActualWidth) / 2)
    $script:notice.Top = $virtualTop + [Math]::Round(($virtualHeight - $script:notice.ActualHeight) / 2) - 48

    $noticeCard.Opacity = 0
    $fadeIn = New-Object System.Windows.Media.Animation.DoubleAnimation(0, 1, [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(200)))
    $noticeCard.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fadeIn)
    $ease = New-Object System.Windows.Media.Animation.CubicEase
    $ease.EasingMode = [System.Windows.Media.Animation.EasingMode]::EaseOut
    $scaleIn = New-Object System.Windows.Media.Animation.DoubleAnimation(0.97, 1, [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(260)))
    $scaleIn.EasingFunction = $ease
    $noticeScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $scaleIn)
    $noticeScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $scaleIn)
    $shiftIn = New-Object System.Windows.Media.Animation.DoubleAnimation(10, 0, [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(280)))
    $shiftIn.EasingFunction = $ease
    $noticeShift.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $shiftIn)

    # The dot breathes: 0.35 -> 1 -> 0.35, never fully off, so it reads as "on air".
    $dotBreath = New-Object System.Windows.Media.Animation.DoubleAnimation(0.35, 1, [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(1200)))
    $dotBreath.AutoReverse = $true
    $dotBreath.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
    $noticeDot.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $dotBreath)

    if ($script:noticeTimer) { $script:noticeTimer.Stop() }
    $script:noticeTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:noticeTimer.Interval = [TimeSpan]::FromSeconds($seconds)
    $script:noticeTimer.Add_Tick({
        $script:noticeTimer.Stop()
        $fadeOut = New-Object System.Windows.Media.Animation.DoubleAnimation(1, 0, [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(360)))
        $fadeOut.Add_Completed({ $script:notice.Hide() })
        $noticeCard.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fadeOut)
    })
    $script:noticeTimer.Start()
}
function Get-HotkeySpec([string]$spec) {
    $parts = $spec.ToLowerInvariant() -split '\+'
    $modifiers = 0
    $key = $null
    foreach ($part in $parts) {
        $piece = $part.Trim()
        if ($piece.Length -eq 0) { continue }
        switch ($piece) {
            'ctrl' { $modifiers = $modifiers -bor 2; continue }
            'control' { $modifiers = $modifiers -bor 2; continue }
            'alt' { $modifiers = $modifiers -bor 1; continue }
            'shift' { $modifiers = $modifiers -bor 4; continue }
            'win' { $modifiers = $modifiers -bor 8; continue }
        }
        if ($piece.Length -eq 1) { $key = [int][char]([char]::ToUpperInvariant($piece[0])) }
        elseif ($piece -match '^f([1-9]|1[0-9]|2[0-4])$') { $key = 111 + [int]$Matches[1] }
        elseif ($piece -eq 'space') { $key = 32 }
        elseif ($piece -eq 'enter') { $key = 13 }
        elseif ($piece -eq 'esc' -or $piece -eq 'escape') { $key = 27 }
        elseif ($piece -eq 'tab') { $key = 9 }
    }
    return @{ Modifiers = ($modifiers -bor 0x4000); Key = $key }
}

function Register-OverlayHotkey {
    # The message hook has to exist before any key can be registered, and the
    # pause key must work even when the optional summon/dock keys are empty —
    # which is the normal configuration here. So the hook is installed first,
    # unconditionally, and the individual keys are registered after it.
    $helper = New-Object System.Windows.Interop.WindowInteropHelper($script:glow)
    $script:hotkeyHandle = $helper.Handle
    $source = [System.Windows.Interop.HwndSource]::FromHwnd($script:hotkeyHandle)
    if ($null -eq $source) {
        Write-Log 'hotkey hook unavailable: no HwndSource'
        if (-not [string]::IsNullOrWhiteSpace($Hotkey)) { Send-Host @{ type = 'hotkey-failed'; hotkey = $Hotkey } }
        return
    }
    [void]$source.AddHook({
        param($hwnd, $message, $wParam, $lParam, $handled)
        if ($message -ne 0x0312) { return [IntPtr]::Zero }
        $id = [int]$wParam
        Write-Log ('WM_HOTKEY id=' + $id)
        if ($id -eq 1) {
            Write-Log 'hotkey fired'
            Send-Host @{ type = 'hotkey' }
            $handled.Value = $true
        } elseif ($id -eq 2) {
            Write-Log 'dock hotkey fired'
            Send-Host @{ type = 'dock-toggle' }
            $handled.Value = $true
        } elseif ($id -eq 3) {
            # The user's own brake: nothing else can set or clear the pause.
            Write-Log 'pause hotkey fired'
            Send-Host @{ type = 'pause-toggle' }
            $handled.Value = $true
        }
        return [IntPtr]::Zero
    })

    if (-not [string]::IsNullOrWhiteSpace($Hotkey)) {
        $spec = Get-HotkeySpec $Hotkey
        if ($null -eq $spec.Key) {
            Set-Status ('热键格式无法识别：' + $Hotkey)
        } else {
            $ok = [OverlayWin32]::RegisterHotKey($script:hotkeyHandle, 1, [uint32]$spec.Modifiers, [uint32]$spec.Key)
            if ($ok) {
                Write-Log ('hotkey registered: ' + $Hotkey + ' pid=' + $PID + ' handle=' + $script:hotkeyHandle)
                $script:hintSuffix = ' · 热键 ' + $Hotkey
                Update-Hint
                Send-Host @{ type = 'hotkey-ready'; hotkey = $Hotkey }
            } else {
                Write-Log ('hotkey registration FAILED: ' + $Hotkey)
                Send-Host @{ type = 'hotkey-failed'; hotkey = $Hotkey }
            }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($DockHotkey)) {
        $dockSpec = Get-HotkeySpec $DockHotkey
        if ($null -ne $dockSpec.Key) {
            $dockOk = [OverlayWin32]::RegisterHotKey($script:hotkeyHandle, 2, [uint32]$dockSpec.Modifiers, [uint32]$dockSpec.Key)
            Write-Log ('dock RegisterHotKey ok=' + $dockOk)
            if ($dockOk) {
                Write-Log ('dock hotkey registered: ' + $DockHotkey + ' ok=' + $dockOk)
                $script:hintSuffix = $script:hintSuffix + ' · 停靠 ' + $DockHotkey
                Update-Hint
            } else {
                Write-Log ('dock hotkey registration FAILED: ' + $DockHotkey)
            }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($PauseHotkey)) {
        $pauseSpec = Get-HotkeySpec $PauseHotkey
        if ($null -ne $pauseSpec.Key) {
            $pauseOk = [OverlayWin32]::RegisterHotKey($script:hotkeyHandle, 3, [uint32]$pauseSpec.Modifiers, [uint32]$pauseSpec.Key)
            Write-Log ('pause RegisterHotKey ok=' + $pauseOk)
            if ($pauseOk) {
                $script:hintSuffix = $script:hintSuffix + ' · 暂停 ' + $PauseHotkey
                Update-Hint
                Send-Host @{ type = 'pause-ready'; hotkey = $PauseHotkey }
            } else {
                Write-Log ('pause hotkey registration FAILED: ' + $PauseHotkey)
                Send-Host @{ type = 'pause-failed'; hotkey = $PauseHotkey }
            }
        }
    }
}
function Set-ClickThrough([System.Windows.Window]$window) {
    $helper = New-Object System.Windows.Interop.WindowInteropHelper($window)
    $handle = $helper.Handle
    if ($handle -eq [IntPtr]::Zero) { return }
    $extended = [OverlayWin32]::GetWindowLong($handle, -20)
    # WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW
    [void][OverlayWin32]::SetWindowLong($handle, -20, ($extended -bor 0x20 -bor 0x08000000 -bor 0x80))
}

# ── placement ───────────────────────────────────────────────────────────────
$virtualLeft = [System.Windows.SystemParameters]::VirtualScreenLeft
$virtualTop = [System.Windows.SystemParameters]::VirtualScreenTop
$virtualWidth = [System.Windows.SystemParameters]::VirtualScreenWidth
$virtualHeight = [System.Windows.SystemParameters]::VirtualScreenHeight

$script:glow.Left = $virtualLeft
$script:glow.Top = $virtualTop
$script:glow.Width = $virtualWidth
$script:glow.Height = $virtualHeight

$script:card.Width = $CardWidth
$script:card.Height = $CardHeight

# The floating card follows the same corner as the docked panel: it used to be
# nailed to the top-right, so choosing 左上角 moved the session window but left
# the card where it was.
function Get-CardAnchor {
    param([double]$width, [double]$height)
    $left = $virtualLeft + $virtualWidth - $width - $CardMargin
    $top = $virtualTop + $CardMargin
    switch ($CardCorner) {
        'topleft' { $left = $virtualLeft + $CardMargin }
        'bottomright' { $top = $virtualTop + $virtualHeight - $height - $CardMargin }
        'bottomleft' {
            $left = $virtualLeft + $CardMargin
            $top = $virtualTop + $virtualHeight - $height - $CardMargin
        }
        'custom' {
            $cx = 0
            $cy = 0
            if ([int]::TryParse($CardX, [ref]$cx) -and [int]::TryParse($CardY, [ref]$cy)) {
                $left = $cx
                $top = $cy
            }
        }
    }
    return @{ left = $left; top = $top }
}

$cardAnchor = Get-CardAnchor $CardWidth $CardHeight
$script:card.Left = $cardAnchor.left
$script:card.Top = $cardAnchor.top

# Keep the card glued to the chosen corner: resizing must not push it off screen.
$script:card.Add_SizeChanged({
    if ($Snapshot -ne '') { return }
    $anchor = Get-CardAnchor $script:card.ActualWidth $script:card.ActualHeight
    if ([Math]::Abs($script:card.Left - $anchor.left) -gt 0.5) { $script:card.Left = $anchor.left }
    $script:card.Top = $anchor.top
})

# Independent width and height drag: the right strip changes width, the bottom
# strip changes height, and the corner changes both. Screen coordinates keep the
# size stable while the window re-anchors its own left edge.
$script:resizeAxis = ''
$script:resizeOriginX = 0
$script:resizeOriginY = 0
$script:resizeBaseWidth = 0
$script:resizeBaseHeight = 0

$beginResize = {
    param($axis)
    $pointer = [System.Windows.Forms.Cursor]::Position
    $script:resizeAxis = $axis
    $script:resizeOriginX = $pointer.X
    $script:resizeOriginY = $pointer.Y
    $script:resizeBaseWidth = $script:card.ActualWidth
    $script:resizeBaseHeight = $script:card.ActualHeight
    [void][System.Windows.Input.Mouse]::Capture($script:card)
}

$endResize = {
    if ($script:resizeAxis -eq '') { return }
    $script:resizeAxis = ''
    [void][System.Windows.Input.Mouse]::Capture($null)
    Send-Host @{
        type   = 'resized'
        width  = [int][Math]::Round($script:card.ActualWidth)
        height = [int][Math]::Round($script:card.ActualHeight)
    }
}

$resizeLeft.Add_MouseLeftButtonDown({ & $beginResize 'left' })
$resizeBottom.Add_MouseLeftButtonDown({ & $beginResize 'bottom' })
$resizeCorner.Add_MouseLeftButtonDown({ & $beginResize 'corner' })

$script:card.Add_MouseMove({
    if ($script:resizeAxis -eq '') { return }
    try {
        $pointer = [System.Windows.Forms.Cursor]::Position
        $deltaX = $pointer.X - $script:resizeOriginX
        $deltaY = $pointer.Y - $script:resizeOriginY
        if ($script:resizeAxis -eq 'left' -or $script:resizeAxis -eq 'corner') {
            $script:card.Width = [Math]::Max(380, $script:resizeBaseWidth - $deltaX)
        }
        if ($script:resizeAxis -eq 'bottom' -or $script:resizeAxis -eq 'corner') {
            $script:card.Height = [Math]::Max(320, $script:resizeBaseHeight + $deltaY)
        }
    } catch {
        $script:resizeAxis = ''
        [void][System.Windows.Input.Mouse]::Capture($null)
    }
})

$script:card.Add_MouseLeftButtonUp({ & $endResize })

$stopButton.Add_Click({
    Send-Host @{ type = 'stop' }
    Set-Status '正在停止…'
    # Nothing guarantees a turn is actually running, so a stop request must not
    # leave the card hanging: hide it if no result arrives shortly.
    if ($script:stopTimer) { $script:stopTimer.Stop(); $script:stopTimer = $null }
    $script:stopTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:stopTimer.Interval = [TimeSpan]::FromSeconds(4)
    $script:stopTimer.Add_Tick({
        $script:stopTimer.Stop()
        $script:stopTimer = $null
        Set-Status '已停止'
        Hide-Permission
        $liveText.Visibility = 'Collapsed'
        Set-CardVisible $false
    })
    $script:stopTimer.Start()
})
$sendButton.Add_Click({ Send-Reply $false })
$micButton.Add_Click({
    if ($script:recording) { Stop-VoiceCapture }
    else { Start-VoiceCapture }
})
$allowButton.Add_Click({ Complete-Permission 'allow' })
$denyButton.Add_Click({ Complete-Permission 'deny' })
$replyBox.Add_KeyDown({
    param($sender, $event)
    if ($event.Key -eq [System.Windows.Input.Key]::Enter) {
        $control = ([System.Windows.Input.Keyboard]::Modifiers -band [System.Windows.Input.ModifierKeys]::Control) -ne 0
        Send-Reply $control
        $event.Handled = $true
    }
})
$replyBox.Add_GotFocus({
    if ($replyBox.Text -eq $script:placeholder) {
        $replyBox.Text = ''
        $replyBox.Foreground = Set-Brush '#EDEDF2'
    }
})
$replyBox.Add_LostFocus({
    if ([string]::IsNullOrWhiteSpace($replyBox.Text)) { Reset-ReplyPlaceholder }
})
Reset-ReplyPlaceholder

# The breathing light is created here but started by Set-GlowVisible, so a
# switched-off glow never gets painted by a running animation.
# 边光只在四条渐变带上呼吸，不再动整个根容器：根容器一暗，目标边框和标牌也跟着
# 一起变，读起来是「一亮一暗地闪」，而不是呼吸。幅度也收窄（0.82↔1.0），
# 用正弦缓动而不是线性——线性动画在折返点很硬，看着像开关灯。
$script:bandPulse = New-Object System.Windows.Media.Animation.DoubleAnimation
$script:bandPulse.From = 0.82
$script:bandPulse.To = 1.0
$script:bandPulse.Duration = [System.Windows.Duration]::new([TimeSpan]::FromSeconds(2.6))
$script:bandPulse.AutoReverse = $true
$script:bandPulse.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
$script:bandPulse.EasingFunction = New-Object System.Windows.Media.Animation.SineEase
$script:bandPulse.EasingFunction.EasingMode = [System.Windows.Media.Animation.EasingMode]::EaseInOut

$dotPulse = New-Object System.Windows.Media.Animation.DoubleAnimation
$dotPulse.From = 0.35
$dotPulse.To = 1.0
$dotPulse.Duration = [System.Windows.Duration]::new([TimeSpan]::FromSeconds(0.9))
$dotPulse.AutoReverse = $true
$dotPulse.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
$pulseDot.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $dotPulse)

if ($State -ne '') {
    $script:stateTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:stateTimer.Interval = [TimeSpan]::FromMilliseconds(900)
    $script:stateTimer.Add_Tick({
        $script:stateTimer.Stop()
        try {
            $fill = $bandTop.Fill
            $fillInfo = 'none'
            if ($fill -is [System.Windows.Media.LinearGradientBrush]) {
                $fillInfo = 'stops=' + $fill.GradientStops.Count + ' a0=' + $fill.GradientStops[0].Color.A + ' rgb=' + $fill.GradientStops[0].Color.R + ',' + $fill.GradientStops[0].Color.G + ',' + $fill.GradientStops[0].Color.B
            } elseif ($null -ne $fill) {
                $fillInfo = $fill.GetType().Name
            }
            $lines = @(
                'bandFill=' + $fillInfo,
                'liveOpacity=' + $glowRoot.Opacity,
                'glowVisible=' + $glow.Visibility,
                'glowActual=' + $glow.ActualWidth + 'x' + $glow.ActualHeight,
                'glowContentChildren=' + $glowRoot.Children.Count,
                'bandTopActual=' + $bandTop.ActualWidth + 'x' + $bandTop.ActualHeight,
                'edgeBrush=' + $edgeLine.BorderBrush
            )
            [System.IO.File]::WriteAllText($State, ($lines -join "`r`n"))
        } catch {
            [System.IO.File]::WriteAllText($State, 'state error: ' + $_.Exception.Message)
        }
    })
    $script:stateTimer.Start()
}
function Append-ReplyText([string]$phrase) {
    if ([string]::IsNullOrWhiteSpace($phrase)) { return }
    if ($replyBox.Text -eq $script:placeholder) { $replyBox.Text = '' }
    $current = $replyBox.Text
    if ($current.Length -gt 0 -and -not $current.EndsWith(' ')) { $current += ' ' }
    $replyBox.Text = $current + $phrase.Trim()
    $replyBox.Foreground = Set-Brush '#EDEDF2'
    $replyBox.CaretIndex = $replyBox.Text.Length
}

function Set-MicColor([string]$color) {
    $micCapsule.Fill = Set-Brush $color
    $micArc.Stroke = Set-Brush $color
    $micStem.Stroke = Set-Brush $color
}

function Start-VoiceCapture {
    if ($script:recording) { return }
    $failure = [VoiceRecorder]::Start()
    if ($null -ne $failure) {
        Set-Status ('录音不可用：' + $failure)
        return
    }
    $script:recording = $true
    $script:silentTicks = 0
    Set-MicColor '#FF6B6B'
    $hintText.Text = '正在录音…再点麦克风结束，静音 1.2 秒也会自动结束'
    Set-Status '正在录音…'
}

function Stop-VoiceCapture([string]$reason = '') {
    if (-not $script:recording) { return }
    $script:recording = $false
    Set-MicColor '#D6D6DE'
    Update-Hint
    $saved = [VoiceRecorder]::Stop($script:voiceFolder)
    if ($saved -like '*:*\*') {
        Set-Status '正在识别…'
        Send-Host @{ type = 'voice'; path = $saved }
    } else {
        Set-Status ('录音失败：' + $saved)
    }
}

# 每 150 ms 看一眼真实光标：靠近标牌就把 ⣿ 把手露出来，移开 1.2 秒收起。
$script:pillHoverTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:pillHoverTimer.Interval = [TimeSpan]::FromMilliseconds(150)
$script:pillHoverTimer.Add_Tick({ try { Update-PillHover } catch { } })
$script:pillHoverTimer.Start()

$script:voiceTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:voiceTimer.Interval = [TimeSpan]::FromMilliseconds(120)
$script:voiceTimer.Add_Tick({
    try {
        if (-not $script:recording) { return }
        if ([VoiceRecorder]::Seconds -gt 45) { Stop-VoiceCapture; return }
        if ([VoiceRecorder]::Level -lt 900) { $script:silentTicks = $script:silentTicks + 1 }
        else { $script:silentTicks = 0 }
        if ([VoiceRecorder]::HeardSpeech -and $script:silentTicks -gt 10) { Stop-VoiceCapture }
    } catch {
        $script:recording = $false
        Set-MicColor '#D6D6DE'
        Set-Status '录音出错'
    }
})
$script:voiceTimer.Start()
$framePulse = New-Object System.Windows.Media.Animation.DoubleAnimation
$framePulse.From = 0.9
$framePulse.To = 1.0
$framePulse.Duration = [System.Windows.Duration]::new([TimeSpan]::FromSeconds(1.2))
$framePulse.AutoReverse = $true
$framePulse.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
$targetFrame.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $framePulse)

$flowAnimation = New-Object System.Windows.Media.Animation.DoubleAnimation(0, -1650, [System.Windows.Duration]::new([TimeSpan]::FromSeconds(3.2)))
$flowAnimation.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
$targetFlow.BeginAnimation([System.Windows.Shapes.Shape]::StrokeDashOffsetProperty, $flowAnimation)
$script:app.Add_DispatcherUnhandledException({
    param($sender, $eventArgs)
    $eventArgs.Handled = $true
})

# Closing the card must never kill the helper: a closed window would also drop
# the global hotkey. Both windows hide instead, and only explicit shutdown exits.
$script:app.ShutdownMode = [System.Windows.ShutdownMode]::OnExplicitShutdown
$script:card.Add_Closing({
    param($sender, $eventArgs)
    $eventArgs.Cancel = $true
    Set-CardVisible $false
})
$script:glow.Add_Closing({
    param($sender, $eventArgs)
    $eventArgs.Cancel = $true
})
$script:app.Add_Exit({
    try {
        if ($null -ne $script:hotkeyHandle -and $script:hotkeyHandle -ne [IntPtr]::Zero) {
            [void][OverlayWin32]::UnregisterHotKey($script:hotkeyHandle, 1)
            [void][OverlayWin32]::UnregisterHotKey($script:hotkeyHandle, 2)
            [void][OverlayWin32]::UnregisterHotKey($script:hotkeyHandle, 3)
        }
    } catch { }
})

$script:app.Add_Startup({
    Set-ClickThrough $script:glow
    Set-ClickThrough $script:notice
})

# ── preview: show off-screen, render both surfaces, exit ────────────────────
if ($Snapshot -ne '') {
    New-Item -ItemType Directory -Force -Path $Snapshot | Out-Null

    Set-Status '正在查看屏幕…'
    $liveText.Text = '正在输出：我先截一张图，确认「设置」窗口在哪，然后点开应用列表。'
    $liveText.Visibility = 'Visible'
    Add-Row -text '截取了主显示器 2560×1440（图为 1600×900）' -kind 'capture'
    Add-Row -text '你：把桌面上的那张截图打开看看' -kind 'user'
    Add-Row -text '我看到桌面右上角有一个播放器窗口正在播放演示视频，先确认它是不是你要的那张图。' -kind 'assistant'
    Add-Row -text '调用 pwsh' -kind 'tool'
    Add-Row -text '在「文件资源管理器」中点击了地址栏' -kind 'input'
    Add-Row -text '点击失败：找不到「ComfyUI」按钮，正在重新截屏' -kind 'error'
    Show-Permission @{
        id     = 'demo-1'
        title  = 'DeepSeek 想在您的电脑上点击鼠标'
        detail = '关闭误打开的开始菜单，并在文件对话框里点选 ComfyUI 生成的图片。'
        risk   = '可以打开、更改或删除任何文件，并运行应用和脚本。'
        app    = 'File Explorer · 仅点击'
        danger = $DangerDemo.IsPresent
    }

    $script:card.Left = -9000
    $script:card.Top = -9000
    $script:glow.Left = -9000
    $script:glow.Top = -9000
    $script:card.Show()
    $script:glow.Show()

    $snapTimer = New-Object System.Windows.Threading.DispatcherTimer
    $snapTimer.Interval = [TimeSpan]::FromMilliseconds(700)
    $snapTimer.Add_Tick({
        $snapTimer.Stop()
        $w = [int]$script:card.ActualWidth
        $h = [int]$script:card.ActualHeight
        $bitmap = New-Object System.Windows.Media.Imaging.RenderTargetBitmap([Math]::Max($w, 1), [Math]::Max($h, 1), 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
        $bitmap.Render($script:card.Content)
        $encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
        $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
        $stream = [System.IO.File]::Create((Join-Path $Snapshot 'card.png'))
        $encoder.Save($stream)
        $stream.Dispose()

        $glowBitmap = New-Object System.Windows.Media.Imaging.RenderTargetBitmap(900, 506, 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
        $glowBitmap.Render($script:glow.Content)
        $glowEncoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
        $glowEncoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($glowBitmap))
        $glowStream = [System.IO.File]::Create((Join-Path $Snapshot 'glow.png'))
        $glowEncoder.Save($glowStream)
        $glowStream.Dispose()

        $noticeTitle.Text = 'DeepSeek 正在使用你的电脑'
        $script:notice.Show()
        $script:notice.UpdateLayout()
        $script:notice.Left = -9000
        $script:notice.Top = -9000
        $script:notice.UpdateLayout()
        $nw = [int]$script:notice.ActualWidth
        $nh = [int]$script:notice.ActualHeight
        $noticeBitmap = New-Object System.Windows.Media.Imaging.RenderTargetBitmap([Math]::Max($nw, 1), [Math]::Max($nh, 1), 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
        $noticeBitmap.Render($script:notice.Content)
        $noticeEncoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
        $noticeEncoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($noticeBitmap))
        $noticeStream = [System.IO.File]::Create((Join-Path $Snapshot 'notice.png'))
        $noticeEncoder.Save($noticeStream)
        $noticeStream.Dispose()

        Send-Host @{ type = 'snapshot'; card = (Join-Path $Snapshot 'card.png'); glow = (Join-Path $Snapshot 'glow.png'); width = $w; height = $h }
        $script:app.Shutdown()
    })
    $snapTimer.Start()

    [void]$script:app.Run()
    exit 0
}

# ── single instance takeover ────────────────────────────────────────────────
# A stale helper keeps the global hotkey registration while its stdin is gone,
# so the keys go nowhere. The newest instance takes over instead.
$script:pidFile = Join-Path $env:TEMP 'dsh-overlay.pid'
try {
    if ($Snapshot -eq '' -and (Test-Path -LiteralPath $script:pidFile)) {
        $previousPid = 0
        $rawPid = Get-Content -LiteralPath $script:pidFile -Raw -ErrorAction SilentlyContinue
        if ($null -ne $rawPid -and [int]::TryParse(([string]$rawPid).Trim(), [ref]$previousPid) -and $previousPid -gt 0 -and $previousPid -ne $PID) {
            $previousProcess = Get-Process -Id $previousPid -ErrorAction SilentlyContinue
            if ($null -ne $previousProcess -and $previousProcess.ProcessName -like 'powershell*') {
                Stop-Process -Id $previousPid -Force -ErrorAction SilentlyContinue
                Start-Sleep -Milliseconds 350
                Write-Log ('took over from stale overlay pid=' + $previousPid)
            }
        }
    }
    if ($Snapshot -eq '') { Set-Content -LiteralPath $script:pidFile -Value $PID -Encoding ASCII }
} catch {
}

# ── live mode ───────────────────────────────────────────────────────────────
# The card and the glow are shown before the first message arrives so their
# handles exist (the hotkey hook is bound to the glow window). Nothing may be
# painted before the first real request: the card is kept transparent and the
# glow's paint is cleared (its breathing animation has not started yet), so a
# switched-off edge light cannot flash at the start of a turn.
if ($StartHidden) {
    $glowRoot.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
    $glowRoot.Opacity = 0
}
if ($StartHidden) { $script:card.Opacity = 0 }
$script:card.Show()
$script:glow.Show()
if ($StartHidden) { Set-CardVisible $false }
Register-OverlayHotkey

Send-Host @{ type = 'ready'; width = $CardWidth }

if ($Demo) {
    Set-Status '正在查看屏幕…'
    Add-Row -text '截取了主显示器 2560×1440（图为 1600×900）' -kind 'capture'
    $script:demoTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:demoTimer.Interval = [TimeSpan]::FromSeconds(2)
    $script:demoTimer.Add_Tick({
        $script:demoTimer.Stop()
        Show-Permission @{
            id     = 'demo-1'
            title  = 'DeepSeek 想在您的电脑上点击鼠标'
            detail = '关闭误打开的开始菜单，并在文件对话框里点选 ComfyUI 生成的图片。'
            risk   = '可以打开、更改或删除任何文件，并运行应用和脚本。'
            app    = 'File Explorer · 仅点击'
        }
    })
    $script:demoTimer.Start()
}

$keepOpen = $Demo
[StdinPump]::Start()
$script:pump = New-Object System.Windows.Threading.DispatcherTimer
$script:pump.Interval = [TimeSpan]::FromMilliseconds(30)
$script:pump.Add_Tick({
    try {
        $message = $null
        while ([StdinPump]::Queue.TryDequeue([ref]$message)) {
            Handle-Message $message
            $message = $null
        }
        if ([StdinPump]::Eof -and -not $keepOpen) {
            $script:pump.Stop()
            $script:app.Shutdown()
        }
    } catch {
        # One bad message must not take the whole overlay (and its edge light)
        # down with it; leave a trail and keep serving the rest of the turn.
        Write-Log ('message error: ' + $_.Exception.Message)
    }
})
$script:pump.Start()

[void]$script:app.Run()
