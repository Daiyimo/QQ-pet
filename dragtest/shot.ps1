# 截全屏（BitBlt SRCCOPY|CAPTUREBLT，含 layered 窗口）
param([string]$out = "shot.png")
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$sig = @'
using System;
using System.Runtime.InteropServices;
public class G {
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, uint rop);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
}
'@
Add-Type -TypeDefinition $sig -ReferencedAssemblies System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$screen = [G]::GetDC([IntPtr]::Zero)
$dc = [G]::CreateCompatibleDC($screen)
$bmp = [G]::CreateCompatibleBitmap($screen, $b.Width, $b.Height)
[G]::SelectObject($dc, $bmp) | Out-Null
[G]::BitBlt($dc, 0, 0, $b.Width, $b.Height, $screen, $b.X, $b.Y, 0x40CC0020) | Out-Null
$img = [System.Drawing.Image]::FromHbitmap($bmp)
$img2 = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g2 = [System.Drawing.Graphics]::FromImage($img2)
$g2.DrawImage($img, 0, 0)
$p = Join-Path $PSScriptRoot $out
$img2.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
$g2.Dispose(); $img2.Dispose()
$img.Dispose()
[G]::DeleteDC($dc) | Out-Null
[G]::DeleteObject($bmp) | Out-Null
[G]::ReleaseDC([IntPtr]::Zero, $screen) | Out-Null
Write-Output $p
