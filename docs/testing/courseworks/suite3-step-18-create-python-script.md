# Suite3 — 第 18 步：创建 Python 脚本

## 测试场景

在空 workspace 中创建 Python 脚本。

## 提示词

```
创建 host-tools/qemu_smoke.py，内容是：
#!/usr/bin/env python3
import subprocess, sys

def run_qemu():
    cmd = ["qemu-system-riscv64", "-machine", "virt", "-nographic"]
    subprocess.run(cmd, check=True)

if __name__ == "__main__":
    run_qemu()
```
