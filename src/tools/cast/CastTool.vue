<template>
  <div class="tool-setup">
    <div class="recording-param-group">
      <div class="param-label">画质</div>
      <el-select v-model="store.castQuality" size="small" class="param-select">
        <el-option value="original" label="原画（不转码）" />
        <el-option value="1080p" label="1080p" />
        <el-option value="720p" label="720p" />
        <el-option value="480p" label="480p" />
        <el-option value="360p" label="360p" />
      </el-select>
    </div>

    <div class="recording-param-group">
      <div class="param-label">视频格式</div>
      <el-select v-model="store.castFormat" size="small" class="param-select">
        <el-option value="auto" label="自动 (推荐)" />
        <el-option value="hls" label="HLS (兼容性好)" />
        <el-option value="mpegts" label="MPEG-TS (低延迟)" />
      </el-select>
    </div>

    <div class="recording-info-hint">
      <p>TVLive 投屏将主界面原画质转码为所选画质（原画 = 直接复制不转码），标准 DLNA 由设备自行拉取原画直链。</p>
      <p>投屏音量由投屏设备自身控制，与主界面音量隔离。</p>
    </div>

    <el-button type="primary" class="start-record-btn" @click="openCastPanel">
      &#x1F4E1; 打开投屏面板
    </el-button>
  </div>
</template>

<script setup lang="ts">
import { useAppStore } from '@/store'

const store = useAppStore()

function openCastPanel() {
  store.showDlna = true
}
</script>