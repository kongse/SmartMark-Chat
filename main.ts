import { Plugin, Editor } from 'obsidian';

export default class AIPlugin extends Plugin {
  async onload() {
    // 添加快捷键 Ctrl+Alt+A
    this.addCommand({
      id: 'call-ai-api',
      name: 'Call AI API',
      hotkeys: [{ modifiers: ["Ctrl", "Alt"], key: "A" }],
      editorCallback: async (editor: Editor) => {
        // 1. 获取当前光标行文本
        const cursor = editor.getCursor();
        const currentLine = editor.getLine(cursor.line);
        
        // 2. 调用AI API（这里用模拟数据，实际需替换为真实API）
        const aiResponse = await this.callAI(currentLine);
        
        // 3. 在下一行插入AI回复
        editor.replaceRange(
          `\n${aiResponse}\n`,  // 插入的内容（前面加换行）
          { line: cursor.line + 1, ch: 0 }  // 从下一行开始
        );
      },
    });
  }

  // 模拟AI API调用（实际需替换为真实API，如OpenAI）
  private async callAI(input: string): Promise<string> {
    // 这里是模拟数据，实际需要替换为真实的API调用
    return `🤖 AI回答：这是关于"${input}"的模拟回复。`;
  }
}