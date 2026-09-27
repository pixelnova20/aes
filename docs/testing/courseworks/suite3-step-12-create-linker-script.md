# Suite3 — 第 12 步：创建 linker script

## 测试场景

在空 workspace 中创建链接脚本。

## 提示词

```
创建文件 linker.ld，内容是 SECTIONS {
    . = 0x80200000;
    .text : { *(.text) }
    .data : { *(.data) }
    .bss : { *(.bss) }
}。
```
