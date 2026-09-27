# Suite4 — Step 4: 精确编辑

## 前置条件
Step 3 已完成。

## 测试目标
验证 agent 在修改单个函数时，使用 edit 做精确替换，而不是 rewrite 整个文件。

## 提示词

```
在 kernel_main.c 中增加一个函数 show_banner()，调用 sbi_putchar 打印一行分隔线 "======"。只修改 kernel_main.c，不要动其他文件。
```
