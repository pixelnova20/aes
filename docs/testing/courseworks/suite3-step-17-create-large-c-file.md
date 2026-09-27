# Suite3 — 第 17 步：创建较长的 C 文件

## 测试场景

在空 workspace 中创建一个包含多个函数的 C 文件。

## 提示词

```
创建文件 kernel/shell.c，内容是：
#include "shell.h"
#include "sbi.h"

static char buf[256];
static int pos = 0;

void shell_init(void) {
    sbi_putchar('>');
    sbi_putchar(' ');
}

void shell_putchar(char c) {
    if (c == '\n') {
        buf[pos] = 0;
        shell_execute(buf);
        pos = 0;
        sbi_putchar('\n');
        shell_init();
    } else {
        buf[pos++] = c;
        sbi_putchar(c);
    }
}
```
