import { Plugin, Editor, Notice, App, PluginSettingTab, Setting } from 'obsidian';
import axios from 'axios';

export default class AIPlugin extends Plugin {
  private apiKey: string = ""; // 你的API密钥
  private apiUrl: string = "https://api.siliconflow.cn/v1/chat/completions"; // 或本地Ollama/LM Studio地址

  async onload() {
    // 加载设置（存储API密钥）
    await this.loadSettings();  // 确保异步加载完成

    // 添加快捷键 Ctrl+Alt+A
    this.addCommand({
      id: 'call-ai-api',
      name: 'Call AI API',
      hotkeys: [{ modifiers: ["Ctrl", "Alt"], key: "A" }],
      editorCallback: async (editor: Editor) => {
        try {
          const cursor = editor.getCursor();
          const currentLine = editor.getLine(cursor.line);

          // 检查API密钥
          if (!this.apiKey) {
            new Notice("⚠️ 请先在插件设置中填写API密钥！");
            return;
          }

          // 调用真实AI API
          const aiResponse = await this.callOpenAI(currentLine);
          
          // 在下一行插入回复
          editor.replaceRange(
            `\n${aiResponse}\n\n`,
            { line: cursor.line + 1, ch: 0 }
          );
        } catch (error) {
          new Notice(`❌ API调用失败: ${error.message}`);
          console.error(error);
        }
      },
    });

    // 添加设置选项卡（用于配置API密钥）
    this.addSettingTab(new AISettingsTab(this.app, this));
  }

  // 调用真实OpenAI兼容API
  private async callOpenAI(input: string): Promise<string> {
    const response = await axios.post(
      this.apiUrl,
      {
        model: "internlm/internlm2_5-7b-chat", // 或本地模型名（如"llama3"）
        messages: [{ role: "user", content: input }],
        temperature: 0.7,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
      }
    );

    return response.data.choices[0].message.content;
  }

  // 加载和保存设置（API密钥）
  private async loadSettings() {
    this.apiKey = (await this.loadData())?.apiKey || "";
  }

  private async saveSettings() {
    await this.saveData({ apiKey: this.apiKey });
  }
}

// 设置选项卡（用于输入API密钥）
class AISettingsTab extends PluginSettingTab {
  plugin: AIPlugin;

  constructor(app: App, plugin: AIPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();
    containerEl.createEl("h2", { text: "AI API 设置" });

    new Setting(containerEl)
      .setName("API密钥")
      .setDesc("输入OpenAI或兼容API的密钥")
      .addText((text) =>
        text
          .setPlaceholder("sk-xxxxxxxx")
          .setValue(this.plugin.apiKey)
          .onChange(async (value) => {
            this.plugin.apiKey = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API地址")
      .setDesc("默认OpenAI官方API，可替换为本地Ollama/LM Studio")
      .addText((text) =>
        text
          .setPlaceholder("https://api.openai.com/v1/chat/completions")
          .setValue(this.plugin.apiUrl)
          .onChange((value) => {
            this.plugin.apiUrl = value;
          })
      );
  }
}