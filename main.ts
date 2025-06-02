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

export default class AIPlugin extends Plugin {
  settings: AIPluginSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: 'call-ai-api',
      name: 'Call AI API',
      hotkeys: [{ modifiers: ["Ctrl", "Alt"], key: "A" }],
      editorCallback: async (editor: Editor) => {
        try {
          const cursor = editor.getCursor();
          const currentLine = editor.getLine(cursor.line);

          if (!this.settings.apiKey) {
            new Notice("⚠️ 请先在插件设置中填写API密钥！");
            return;
          }

          // 先格式化文本
          this.formatSelectedText(editor);

          // 获取格式化后的当前行内容（去掉"USER: "前缀）
          const formattedLine = editor.getLine(cursor.line);
          const queryText = formattedLine.replace("USER: ", "");

          const aiResponse = await this.callOpenAI(queryText);

          // 在下一行插入回复
          editor.replaceRange(
            //`\nAI: ${aiResponse}\n`,
            `\n${aiResponse}\n`,
            { line: cursor.line + 2, ch: 0 }
          );
        } catch (error) {
          new Notice(`调用AI API出错: ${error}`);
          console.error(error);
        }
      }
    });

    this.addCommand({
      id: 'format-text',
      name: 'Format selected text',
      editorCallback: (editor: Editor) => {
        this.formatSelectedText(editor);
      }
    });

    // 添加设置选项卡（用于配置API密钥）
    this.addSettingTab(new AISettingsTab(this.app, this));
  }

  private async callOpenAI(input: string): Promise<string> {
    const response = await this.generateResponse(input);
    return response;
  }

  private async getContextMessages(): Promise<Array<{role: string, content: string}>> {
    const editor = this.app.workspace.activeEditor?.editor;
    if (!editor) return [];
    
    const currentLine = editor.getCursor().line;
    const messages: Array<{role: string, content: string}> = [];
    let aiResponse = "";
    let isCollectingAIResponse = false;
    
    // 从当前行向上遍历
    for (let i = currentLine - 1; i >= 0 && messages.length < this.settings.contextLines * 2; i--) {
        const line = editor.getLine(i).trim();
        
        if (line.startsWith('>USER: ')) {
            // 如果之前在收集AI回复，先保存收集到的内容
            if (isCollectingAIResponse && aiResponse) {
                messages.unshift({
                    role: 'assistant',
                    content: aiResponse.trim()
                });
                aiResponse = "";
                isCollectingAIResponse = false;
            }
            
            messages.unshift({
                role: 'user',
                content: line.replace('>USER: ', '')
            });
        } else if (line.includes('AI:')) {
            // 遇到AI:开始收集回复
            if (isCollectingAIResponse && aiResponse) {
                messages.unshift({
                    role: 'assistant',
                    content: aiResponse.trim()
                });
                aiResponse = "";
            }
            isCollectingAIResponse = true;
            aiResponse = line.split('AI:')[1] + '\n';
        } else if (line.includes('LLM')) {
            // 遇到LLM标记结束当前AI回复的收集
            if (isCollectingAIResponse) {
                isCollectingAIResponse = false;
                if (aiResponse) {
                    messages.unshift({
                        role: 'assistant',
                        content: aiResponse.trim()
                    });
                    aiResponse = "";
                }
            }
        } else if (isCollectingAIResponse) {
            // 如果正在收集AI回复，将当前行添加到回复内容中
            aiResponse = line + '\n' + aiResponse;
        }
    }
    
    // 处理最后一个可能未处理的AI回复
    if (isCollectingAIResponse && aiResponse) {
        messages.unshift({
            role: 'assistant',
            content: aiResponse.trim()
        });
    }
    
    return messages;
}

private async generateResponse(prompt: string): Promise<string> {
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
    
    const response = await fetch(this.settings.apiUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.settings.apiKey}`
        },
        body: JSON.stringify({
            model: this.settings.modelName,
            messages: fullMessages
        })
    });

    const data = await response.json();
    return data.choices[0].message.content;
}

  private async loadSettings() {
    this.settings = Object.assign({}, this.settings, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async formatSelectedText(editor: Editor): Promise<{ line: number, ch: number }> {
    const cursor = editor.getCursor();
    const baseLine = cursor.line; // 统一使用执行时光标所在行作为基础行号
    const originalText = editor.getLine(baseLine);

    // 1. 在基础行插入代码块开始标记
    editor.replaceRange(">USER: ", { line: baseLine, ch: 0 });
    
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

async sendToAI() {
  const editor = this.app.workspace.activeEditor?.editor;
  if (!editor) return;

  // 获取当前光标位置作为基础行号
  const baseLine = editor.getCursor().line;
  const query = editor.getSelection() || editor.getLine(baseLine); // 优先使用选中文本，没有则用整行

  // 格式化文本并获取插入位置
  const insertPos = await this.formatSelectedText(editor);
  
  try {
      // 获取AI回复
      const aiResponse = await this.callOpenAI(query);
      
      // 在计算好的位置插入AI回复
      editor.replaceRange(`${aiResponse}\n`, insertPos);
      
      // 移动光标到AI回复的末尾
      editor.setCursor(editor.lastLine());
      
  } catch (error) {
      console.error("AI调用失败:", error);
      editor.replaceRange("\n[AI请求失败]\n", insertPos);
  }
}
}

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