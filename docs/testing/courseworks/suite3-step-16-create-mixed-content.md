# Suite3 — 第 16 步：创建混合内容文件

## 测试场景

创建文件，内容混合了目录和文件操作。

## 提示词

```
创建目录 tests/，然后创建 tests/test_main.c 内容是 #include <stdio.h>
int main() { printf("Tests passed\n"); return 0; }，同时创建 tests/Makefile 内容是 test: test_main.c
	gcc -o test test_main.c
	./test。
```
