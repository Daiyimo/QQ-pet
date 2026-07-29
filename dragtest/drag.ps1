# 模拟鼠标拖拽 v2：全程 SendInput 绝对坐标移动，更贴近真实输入
param([int]$x1, [int]$y1, [int]$x2, [int]$y2)
Add-Type -AssemblyName System.Windows.Forms
$sig = @'
using System;
using System.Runtime.InteropServices;
public class U32 {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
}
'@
Add-Type -TypeDefinition $sig -ReferencedAssemblies System.Windows.Forms
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
function MoveAbs([int]$x, [int]$y) {
  $nx = [int](($x * 65535) / ($b.Width - 1))
  $ny = [int](($y * 65535) / ($b.Height - 1))
  [U32]::mouse_event(0x8001, $nx, $ny, 0, 0)  # ABSOLUTE | MOVE
}
MoveAbs $x1 $y1
Start-Sleep -Milliseconds 500
[U32]::mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
Start-Sleep -Milliseconds 400
$steps = 25
for ($i = 1; $i -le $steps; $i++) {
  $cx = [int]($x1 + ($x2 - $x1) * $i / $steps)
  $cy = [int]($y1 + ($y2 - $y1) * $i / $steps)
  MoveAbs $cx $cy
  Start-Sleep -Milliseconds 40
}
Start-Sleep -Milliseconds 200
[U32]::mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
Start-Sleep -Milliseconds 300
