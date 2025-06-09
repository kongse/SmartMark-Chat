import { Plugin, Editor, Notice, App, PluginSettingTab, Setting } from 'obsidian';

interface AIPluginSettings {
  apiKey: string;
  apiUrl: string;
  modelName: string;
  systemPrompt: string;
  contextLines: number; // 添加设置项：收集多少轮对话作为上下文
}

const DEFAULT_SETTINGS: AIPluginSettings = {
  apiKey: "",
  apiUrl: "https://api.openai.com/v1/chat/completions",
  modelName: "gpt-3.5-turbo",  // 确保有默认值
  systemPrompt: "你是一个有帮助的AI助手",
  contextLines: 3  // 默认收集3轮对话
};

// 主插件类
export default class AIPlugin extends Plugin {
  settings: AIPluginSettings = DEFAULT_SETTINGS;
  private streamInsertPosition: { line: number, ch: number } | null = null;
  private lastContentLength = 0;
  private statusNotice: Notice | null = null; // 添加状态提示变量

  async onload() {
    await this.loadSettings();
    //  按快捷键时执行
    this.addCommand({
      id: 'call-ai-api',
      name: 'Call AI API',
      hotkeys: [{ modifiers: ["Ctrl"], key: "Enter" }],
      editorCallback: async (editor: Editor) => {
        try {
          const cursor = editor.getCursor();
          const currentLine = editor.getLine(cursor.line);
      
          if (!this.settings.apiKey) {
            new Notice("⚠️ Please SETUP API Keys First！");
            return;
          }
      
          // 在当前行前面添加===（如果还没有的话）
          if (!currentLine.startsWith('===')) {
            editor.replaceRange("===", { line: cursor.line, ch: 0 });
          }
      
          // 直接调用AI，generateResponse中会自动调用getContextMessages()获取完整上下文
          await this.callOpenAI(""); // 传空字符串，因为上下文已经在getContextMessages中处理了
      
        } catch (error) {
          new Notice(`CALL AI API ERROR: ${error}`);
          console.error(error);
        }
      }
    });

    // 添加命令用于格式化文本
    this.addCommand({
      id: 'format-text',
      name: 'Format selected text',
      editorCallback: (editor: Editor) => {
        this.formatSelectedText(editor);
      }
    });

    // 添加设置选项卡 (用于配置AI参数等)
    this.addSettingTab(new AISettingsTab(this.app, this));
  }

  // OpenAI API调用函数
  private async callOpenAI(input: string): Promise<string> {
    // 显示开始状态
    this.showStatusNotice("🤖 AI正在思考中...");
    
    try {
      const response = await this.generateResponse(input);
      return response;
    } catch (error) {
      // 出错时隐藏状态提示
      this.hideStatusNotice();
      throw error;
    }
  }

  private async generateResponse(prompt: string): Promise<string> {
    // 重置流式输出状态
    this.streamInsertPosition = null;
    this.lastContentLength = 0;
    
    // 获取上下文对话
    const messages = await this.getContextMessages();
    
    // 构建完整的消息数组
    const fullMessages = [
        { role: "system", content: this.settings.systemPrompt },
        ...messages,
        { role: "user", content: prompt }
    ];
    
    // 将消息转换为JSON字符串并复制到剪贴板
    await navigator.clipboard.writeText(JSON.stringify(fullMessages, null, 2));
    new Notice("已将对话上下文复制到剪贴板");
    
    // 更新状态为连接中
    this.updateStatusNotice("🔗 正在连接AI服务...");
    
    const response = await fetch(this.settings.apiUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.settings.apiKey}`
        },
        body: JSON.stringify({
            model: this.settings.modelName,
            messages: fullMessages,
            stream: true  // 启用流式传输
        })
    });

    if (!response.body) {
        this.hideStatusNotice();
        throw new Error('Response body is null');
    }

    // 更新状态为接收回复
    this.updateStatusNotice("📝 AI正在回复中...");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let result = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                // 流式输出结束，添加<<标记
                this.finalizeStreamingContent();
                // 隐藏状态提示
                this.hideStatusNotice();
                break;
            }

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') {
                        this.finalizeStreamingContent();
                        this.hideStatusNotice();
                        return result;
                    }

                    try {
                        const parsed = JSON.parse(data);
                        const content = parsed.choices?.[0]?.delta?.content;
                        if (content) {
                            result += content;
                            // 增量更新编辑器内容
                            this.updateStreamingContent(content);
                        }
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            }
        }
    } finally {
        reader.releaseLock();
        // 确保状态提示被隐藏
        this.hideStatusNotice();
    }

    return result;
  }

  // 显示状态提示
  private showStatusNotice(message: string) {
    // 如果已有状态提示，先隐藏
    this.hideStatusNotice();
    
    // 创建新的状态提示，设置较长的显示时间
    this.statusNotice = new Notice(message, 0); // 0表示不自动隐藏
  }

  // 更新状态提示内容
  private updateStatusNotice(message: string) {
    if (this.statusNotice) {
      // 隐藏当前提示，显示新提示
      this.hideStatusNotice();
    }
    this.showStatusNotice(message);
  }

  // 隐藏状态提示
  private hideStatusNotice() {
    if (this.statusNotice) {
      this.statusNotice.hide();
      this.statusNotice = null;
    }
  }

  // 保存收集的内容到消息数组的辅助函数
  private saveCollectedContent(
    messages: Array<{role: string, content: string}>,
    collectingContent: string,
    collectingMode: 'user' | 'assistant' | 'none'
  ): void {
    if (collectingContent.trim() && collectingMode !== 'none') {
      messages.unshift({
        role: collectingMode,
        content: collectingContent.trim()
      });
    }
  }

  private async getContextMessages(): Promise<Array<{role: string, content: string}>> {
      const editor = this.app.workspace.activeEditor?.editor;
      if (!editor) return [];
      
      const currentLine = editor.getCursor().line;
      const messages: Array<{role: string, content: string}> = [];
      let collectingContent = "";
      let collectingMode: 'user' | 'assistant' | 'none' = 'none';
      
      // 从当前行向上遍历
      for (let i = currentLine; i >= 0 && messages.length < this.settings.contextLines * 2; i--) {
          const line = editor.getLine(i);
          const trimmedLine = line.trim();
          
          // 检查终止条件：遇到=-=开头的行
          if (trimmedLine.startsWith('=-=')) {
              // 终止收集循环
              break;
          }
          
          // 检查用户输入标记（===）
          if (line.includes('===')) {
          // 优先处理：行首行尾都有===且长度大于6的情况（多行输入开始）
          if (line.startsWith('===') && line.endsWith('===') && line.length > 6) {
          // 保存之前收集的内容（如果有）
          this.saveCollectedContent(messages, collectingContent, collectingMode);
          
          // 获取===之间的内容作为当前行的用户输入内容
          const userContent = line.substring(3, line.length - 3).trim();
          
          // 开始收集多行用户输入，将当前行内容加入
          collectingContent = userContent;
          collectingMode = 'user';
          }
          // 其次处理：行尾有===的情况（多行输入结束）
          else if (line.endsWith('===') && !line.startsWith('===')) {
          // 保存之前收集的内容（如果有）
          this.saveCollectedContent(messages, collectingContent, collectingMode);
          
          // 获取===之前的内容作为当前行的用户输入内容
          const userContent = line.substring(0, line.length - 3).trim();
          
          // 开始收集多行用户输入，将当前行内容加入
          collectingContent = userContent;
          collectingMode = 'user';
          }
          // 最后处理：行首有===的情况（单行输入）
          else if (line.startsWith('===') && !line.endsWith('===')) {
          // 保存之前收集的内容（如果有）
          this.saveCollectedContent(messages, collectingContent, collectingMode);
          
          // 单行用户输入：直接收集===这一行作为用户输入
          const userContent = line.substring(3).trim(); // 去掉===
          messages.unshift({
          role: 'user',
          content: userContent
          });
          
          // 重启收集循环
          collectingContent = "";
          collectingMode = 'none';
          }
          // 单独的===行（长度等于3）将被忽略，不做任何处理
          }
          // 检查AI输入标记（= =）
          else if (line.includes('= =')) {
          // 优先处理：行首行尾都有= =且长度大于6的情况（多行输入开始）
          if (line.startsWith('= =') && line.endsWith('= =') && line.length > 6) {
          // 保存之前收集的内容（如果有）
          this.saveCollectedContent(messages, collectingContent, collectingMode);
          
          // 获取= =之间的内容作为当前行的AI输入内容
          const aiContent = line.substring(3, line.length - 3).trim();
          
          // 开始收集多行AI输入，将当前行内容加入
          collectingContent = aiContent;
          collectingMode = 'assistant';
          }
          // 其次处理：行尾有= =的情况（多行输入结束）
          else if (line.endsWith('= =') && !line.startsWith('= =')) {
          // 保存之前收集的内容（如果有）
          this.saveCollectedContent(messages, collectingContent, collectingMode);
          
          // 获取"= ="之前的内容作为当前行的AI输入内容
          const aiContent = line.substring(0, line.length - 3).trim();
          
          // 开始收集多行AI输入，将当前行内容加入
          collectingContent = aiContent;
          collectingMode = 'assistant';
          }
          // 最后处理：行首有= =的情况（单行输入）
          else if (line.startsWith('= =') && !line.endsWith('= =')) {
          // 保存之前收集的内容（如果有）
          this.saveCollectedContent(messages, collectingContent, collectingMode);
          
          // 单行AI输入：直接收集= =这一行作为AI输入
          const aiContent = line.substring(3).trim(); // 去掉"= ="
          messages.unshift({
          role: 'assistant',
          content: aiContent
          });
          
          // 重启收集循环
          collectingContent = "";
          collectingMode = 'none';
          }
          // 单独的= =行（长度等于3）将被忽略，不做任何处理
          }
          else if (line.startsWith('-----')) {
              // 结束标记，保存收集的内容
              this.saveCollectedContent(messages, collectingContent, collectingMode);
              
              // 重启收集循环
              collectingContent = "";
              collectingMode = 'none';
          }
          else if (collectingMode !== 'none') {
              // 在收集模式下，收集当前行内容
              if (collectingContent) {
                  collectingContent = line + '\n' + collectingContent;
              } else {
                  collectingContent = line;
              }
          }
      }
      
      // 处理遍历结束时可能未保存的内容
      this.saveCollectedContent(messages, collectingContent, collectingMode);
      
      return messages;
  }

// Flowing Content Updater
private updateStreamingContent(newContent: string) {
    const editor = this.app.workspace.activeEditor?.editor;
    if (!editor) return;
    
    // 如果还没有设置插入位置，初始化插入位置
    if (!this.streamInsertPosition) {
        const cursor = editor.getCursor();
        // 确保插入位置不会超出文档边界
        const doc = editor.getDoc();
        const lastLine = doc.lastLine();
        const lastLineLength = doc.getLine(lastLine).length;
        
        // 如果光标在最后一行，先添加换行符
        if (cursor.line >= lastLine) {
            const endPos = { line: lastLine, ch: lastLineLength };
            editor.replaceRange("\n", endPos);
            this.streamInsertPosition = { line: lastLine + 1, ch: 0 };
        } else {
            this.streamInsertPosition = { line: cursor.line + 1, ch: 0 };
        }
        
        // 插入AI标记
        editor.replaceRange("-----\n", this.streamInsertPosition);
        this.streamInsertPosition.ch = 6; // "-----\n"的长度
    }
    
    // 计算当前应该插入的位置
    const currentPos = {
        line: this.streamInsertPosition.line,
        ch: this.streamInsertPosition.ch + this.lastContentLength
    };
    
    // 只插入新增的内容
    editor.replaceRange(newContent, currentPos);
    this.lastContentLength += newContent.length;
}

// 在流式输出结束后添加= =标记
private finalizeStreamingContent() {
    const editor = this.app.workspace.activeEditor?.editor;
    if (!editor || !this.streamInsertPosition) return;
    
    // 生成时间戳
    const now = new Date();
    const timestamp = now.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).replace(/\//g, '/').replace(/,/g, '');
    
    // 获取当前AI回答内容的结束位置
    const endPos = {
        line: this.streamInsertPosition.line,
        ch: this.streamInsertPosition.ch + this.lastContentLength
    };

    editor.replaceRange('= =', endPos);
    //editor.replaceRange(`\n<<  [Timestamp: ${timestamp}]\n\n`, endPos);

}

// 加载设置
private async loadSettings() {
    this.settings = Object.assign({}, this.settings, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // 格式化用户输入行
  // 格式化用户输入行
private async formatSelectedText(editor: Editor): Promise<{ line: number, ch: number }> {
    const cursor = editor.getCursor();
    const baseLine = cursor.line; // 统一使用执行时光标所在行作为基础行号
    const originalText = editor.getLine(baseLine);

    // 1. 检查行首是否已经===，如果没有才插入
    if (!originalText.startsWith('===')) {
        editor.replaceRange("===", { line: baseLine, ch: 0 });
    }
    
    // 2. 在下一行添加USER:前缀
    //editor.setLine(baseLine, `USER: ${originalText}`);
    
    // 3. 在再下一行插入代码块结束标记
    // editor.replaceRange("\n```", { line: baseLine, ch: 0 });
    
    // 4. 返回结束位置（代码块结束标记的下一行开头）
    return { 
        line: baseLine + 3, // 基础行 + 3行
        ch: 0
    };
}

// 发送文本到AI
async sendToAI() {
  const editor = this.app.workspace.activeEditor?.editor;
  if (!editor) return;

  // 获取当前光标位置作为基础行号
  const baseLine = editor.getCursor().line;
  const query = editor.getSelection() || editor.getLine(baseLine); // 优先使用选中文本，没有则用整行

  // 格式化文本并获取插入位置
  const insertPos = await this.formatSelectedText(editor);
  
  try {
      // 获取AI回复 - 流式输出已经在generateResponse中处理了
      await this.callOpenAI(query);
      
      // 移动光标到AI回复的末尾
      editor.setCursor(editor.lastLine());
      
  } catch (error) {
      console.error("AI调用失败:", error);
      editor.replaceRange("\n[AI请求失败]\n", insertPos);
  }
}
}

// 设置 AI 选项卡
class AISettingsTab extends PluginSettingTab {
    // 显式声明私有属性
    private plugin: AIPlugin;

    constructor(app: App, plugin: AIPlugin) {
        super(app, plugin);
        this.plugin = plugin; // 必须赋值
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName("API密钥")
            .setDesc("输入OpenAI或兼容API的密钥")
            .addText(text => text
                .setPlaceholder("sk-xxxxxxxx")
                .setValue(this.plugin.settings.apiKey)
                .onChange(async (value) => {
                    this.plugin.settings.apiKey = value;
                    await this.plugin.saveSettings();
                }));
    
        new Setting(containerEl)
            .setName("API地址")
            .setDesc("默认OpenAI官方API，可替换为本地Ollama/LM Studio")
            .addText(text => text
                .setPlaceholder("https://api.openai.com/v1/chat/completions")
                .setValue(this.plugin.settings.apiUrl)
                .onChange(async (value) => {
                    this.plugin.settings.apiUrl = value;
                    await this.plugin.saveSettings();
                }));
    
        new Setting(containerEl)
            .setName("模型名称")
            .setDesc("设置要使用的AI模型名称（如gpt-3.5-turbo, gpt-4等）")
            .addText(text => text
                .setPlaceholder("gpt-3.5-turbo")
                .setValue(this.plugin.settings.modelName)
                .onChange(async (value) => {
                    this.plugin.settings.modelName = value;
                    await this.plugin.saveSettings();
                }));
    
        new Setting(containerEl)
            .setName("系统提示词")
            .setDesc("设置AI的系统角色和初始指令")
            .addTextArea(text => {
                text.setPlaceholder("你是一个有帮助的AI助手")
                    .setValue(this.plugin.settings.systemPrompt)
                    .onChange(async (value) => {
                        this.plugin.settings.systemPrompt = value;
                        await this.plugin.saveSettings();
                    });
                
                // 设置文本区域的大小
                text.inputEl.rows = 8;  // 设置行数为8行
                text.inputEl.cols = 50; // 设置列数为50列
                text.inputEl.style.width = '100%';  // 设置宽度为100%
                text.inputEl.style.minHeight = '120px';  // 设置最小高度
                text.inputEl.style.resize = 'vertical';  // 允许垂直调整大小
            });
    
        new Setting(containerEl)
            .setName("上下文对话轮数")
            .setDesc("设置在调用AI时收集多少轮历史对话作为上下文（0表示不收集）")
            .addText(text => text
                .setPlaceholder("3")
                .setValue(String(this.plugin.settings.contextLines))
                .onChange(async (value) => {
                    this.plugin.settings.contextLines = Number(value) || 0;
                    await this.plugin.saveSettings();
                }));
    }
}