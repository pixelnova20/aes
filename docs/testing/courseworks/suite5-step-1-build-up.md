# Suite5 — Step 1: 积累对话轮次

## 测试目标
快速积累 25+ 轮对话，触发自动压缩。

## 提示词

依次输入以下短 prompt（每次等待 run 完成后再输入下一个）：

```
创建文件 a.txt，内容是 AAA
```

```
创建文件 b.txt，内容是 BBB
```

```
创建文件 c.txt，内容是 CCC
```

```
创建文件 d.txt，内容是 DDD
```

```
创建文件 e.txt，内容是 EEE
```

```
创建 src/main.c，内容是 int main() { return 0; }
```

```
创建 Makefile，内容是 all: main.c\n\tgcc -o main main.c
```

```
运行 make
```

```
查看工作区文件列表
```

```
删除 a.txt
```

```
删除 b.txt
```

```
创建 README.md，内容为 # Test Project
```

这些是示意——实际只需快速提交 12-15 个短 prompt，每轮产生 2 条 turn（user + assistant）。
