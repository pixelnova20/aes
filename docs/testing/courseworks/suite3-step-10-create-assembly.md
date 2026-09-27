# Suite3 — 第 10 步：创建汇编文件

## 测试场景

在空 workspace 中创建 RISC-V 汇编文件。

## 提示词

```
创建文件 boot.S，内容是 .section .text
.globl _start
_start:
    li sp, 0x80000000
    call kernel_main
    j .。
```
