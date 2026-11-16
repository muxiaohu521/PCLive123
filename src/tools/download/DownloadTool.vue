<template>
  <div>
    <div class="tool-setup">
      <div class="recording-param-group">
        <div class="param-label">视频流地址</div>
        <textarea
          v-model="downloadUrl"
          class="download-url-input"
          rows="2"
          placeholder="输入 m3u8 / flv / ts / mp4 等视频流地址"
        ></textarea>
        <div class="download-use-current" v-if="currentDownloadUrl">
          <span>当前播放频道：</span>
          <span class="download-channel-name">{{ downloadTitle }}</span>
          <button class="action-btn add-btn" @click="useCurrentChannel">使用当前频道</button>
        </div>
      </div>

      <div class="recording-param-group">
        <div class="param-label">保存文件夹</div>
        <div class="output-path-row">
          <input type="text" class="output-path-input" :value="downloadOutputDir" readonly placeholder="未选择时默认保存到 out 文件夹..." />
          <button class="browse-btn" @click="selectDownloadFolder">浏览...</button>
          <button class="browse-btn" @click="openDownloadFolder(undefined, downloadOutputDir)">打开目录</button>
        </div>
      </div>

      <div class="recording-param-group">
        <div class="param-label">并列同时下载数上限</div>
        <el-select v-model="downloadMaxConcurrent" size="small" class="param-select concurrent-select" @change="setMaxConcurrent">
          <el-option v-for="n in 10" :key="n" :value="n" :label="String(n)" />
        </el-select>
      </div>

      <div class="recording-param-group">
        <div class="param-label">分片清理模式</div>
        <el-radio-group v-model="downloadCleanupMode" class="mode-radio-group">
          <el-radio value="manual" class="mode-radio">
            <span class="mode-title">手动清理</span>
            <span class="mode-desc">合并后保留分片文件夹</span>
          </el-radio>
          <el-radio value="auto" class="mode-radio">
            <span class="mode-title">自动清理</span>
            <span class="mode-desc">合并成功后自动删除分片文件夹</span>
          </el-radio>
        </el-radio-group>
      </div>

      <div class="recording-info-hint">
        <p>复用当前播放接口抓取视频流，HLS 按分片缓存下载后使用内置 FFmpeg 无损合并（非转码）。</p>
        <p>未点击停止时，默认最长下载 6 小时自动停止并合并。</p>
        <p>不同频道的链接并列下载；相同链接已下载完成或进行中的会自动跳过。</p>
      </div>

      <el-button
        type="primary"
        class="start-record-btn"
        :disabled="!downloadUrl.trim()"
        @click="startDownload"
      >
        &#x23EC; 开始下载
      </el-button>
    </div>

    <div v-if="downloadTasks.length" class="download-task-list">
      <div v-for="t in downloadTasks" :key="t.id" class="download-task-item">
        <div class="download-task-head">
          <span class="download-task-title">{{ t.title || '未命名频道' }}</span>
          <div class="download-task-actions">
            <el-button v-if="t.status !== 'done'" size="small" type="danger" @click="stopDownload(t.id)">&#x23F9; 停止</el-button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useDownload } from './useDownload'

const {
  downloadUrl,
  downloadOutputDir,
  downloadCleanupMode,
  downloadMaxConcurrent,
  downloadTasks,
  downloadTitle,
  currentDownloadUrl,
  useCurrentChannel,
  selectDownloadFolder,
  setMaxConcurrent,
  startDownload,
  stopDownload,
  openDownloadFolder,
} = useDownload()
</script>

<style scoped>
.download-url-input {
  width: 100%;
  background: #1e1e2e;
  border: 1px solid #2a2a3e;
  border-radius: 8px;
  color: #e0e0e0;
  font-size: 12px;
  padding: 8px 10px;
  resize: vertical;
  font-family: inherit;
}

.download-url-input:focus { outline: none; border-color: #4fc3f7; }

.download-use-current {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 12px;
  color: #aaa;
  flex-wrap: wrap;
}

.download-channel-name { color: #4fc3f7; font-weight: 600; }

.concurrent-select { max-width: 120px; }

.download-task-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 16px;
}

.download-task-item {
  padding: 10px 12px;
  background: #1e1e2e;
  border: 1px solid #2a2a3e;
  border-radius: 8px;
}

.download-task-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.download-task-title {
  color: #e0e0e0;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.download-task-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
</style>