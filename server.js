const cors = require('cors');
app.use(cors());
const express = require('express');
const ytdl = require('@distube/ytdl-core');
const ytsr = require('ytsr');
const path = require('path');
const fs = require('fs');
const NodeCache = require('node-cache');

const app = express();
const port = process.env.PORT || 3000;

// Cache para resultados (1 hora de duración)
const cache = new NodeCache({ stdTTL: 3600 });

// Middleware
app.use(express.static('public'));
app.use(express.json());

// Ruta principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API de búsqueda ultra rápida
app.get('/api/search', async (req, res) => {
  const query = req.query.query;
  const maxResults = parseInt(req.query.max) || 8;
  
  if (!query) {
    return res.status(400).json({ error: 'Query requerido' });
  }

  // Verificar cache
  const cacheKey = `search:${query}:${maxResults}`;
  const cachedResults = cache.get(cacheKey);
  if (cachedResults) {
    return res.json(cachedResults);
  }

  try {
    console.time(`Búsqueda: ${query}`);
    
    // Búsqueda paralela y optimizada
    const searchResults = await ytsr(query, { 
      limit: maxResults,
      safeSearch: false 
    });

    const results = searchResults.items
      .filter(item => item.type === 'video')
      .slice(0, maxResults)
      .map(item => ({
        id: item.id,
        title: item.title,
        duration: item.duration,
        thumbnail: item.bestThumbnail?.url || item.thumbnails?.[0]?.url,
        channel: item.author?.name,
        views: item.views,
        url: item.url
      }));

    // Guardar en cache
    cache.set(cacheKey, results);
    
    console.timeEnd(`Búsqueda: ${query}`);
    res.json(results);

  } catch (error) {
    console.error('Error en búsqueda:', error);
    res.status(500).json({ error: 'Error en la búsqueda' });
  }
});

// API para obtener info de video (ultra rápida)
app.get('/api/video/:id', async (req, res) => {
  const videoId = req.params.id;
  const cacheKey = `video:${videoId}`;
  
  // Verificar cache
  const cachedInfo = cache.get(cacheKey);
  if (cachedInfo) {
    return res.json(cachedInfo);
  }

  try {
    console.time(`Info video: ${videoId}`);
    
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    
    // Verificar si el video es válido
    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'URL de video inválida' });
    }
    
    const info = await ytdl.getInfo(url, {
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      }
    });
    
    const audioFormats = ytdl.filterFormats(info.formats, 'audioonly');
    
    if (audioFormats.length === 0) {
      return res.status(404).json({ error: 'No se encontraron formatos de audio' });
    }
    
    const bestAudio = audioFormats.reduce((best, format) => {
      return format.audioBitrate > (best.audioBitrate || 0) ? format : best;
    }, {});

    const result = {
      id: videoId,
      title: info.videoDetails.title,
      duration: info.videoDetails.lengthSeconds,
      thumbnail: info.videoDetails.thumbnails?.[info.videoDetails.thumbnails.length - 1]?.url,
      channel: info.videoDetails.author.name,
      audioUrl: bestAudio.url,
      formats: audioFormats.slice(0, 3).map(f => ({
        quality: f.audioQuality,
        bitrate: f.audioBitrate,
        codec: f.audioCodec,
        url: f.url
      }))
    };

    cache.set(cacheKey, result, 1800); // 30 minutos de cache
    console.timeEnd(`Info video: ${videoId}`);
    res.json(result);

  } catch (error) {
    console.error('Error obteniendo info:', error.message);
    
    // Manejo específico de errores
    if (error.message.includes('Video unavailable')) {
      return res.status(404).json({ error: 'Video no disponible' });
    } else if (error.message.includes('private')) {
      return res.status(403).json({ error: 'Video privado' });
    } else if (error.message.includes('age-restricted')) {
      return res.status(403).json({ error: 'Video con restricción de edad' });
    }
    
    res.status(500).json({ error: 'Error obteniendo información del video' });
  }
});

// Stream de audio directo (sin descarga)
app.get('/stream/:id', async (req, res) => {
  const videoId = req.params.id;
  const quality = req.query.quality || 'highestaudio';
  
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    
    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'URL de video inválida' });
    }
    
    const info = await ytdl.getInfo(url, {
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      }
    });
    
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `inline; filename="${info.videoDetails.title}.mp3"`);
    res.setHeader('Cache-Control', 'no-cache');
    
    const audioStream = ytdl(url, {
      quality: quality,
      filter: 'audioonly',
      highWaterMark: 1 << 25,
      requestOptions: {
        headers: {
          // Usar User-Agent móvil para evitar restricciones
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-A205U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36'
        }
      }
    });
    
    audioStream.on('error', (error) => {
      console.error('Error en streaming:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error en streaming' });
      }
    });
    
    audioStream.pipe(res);
    
  } catch (error) {
    console.error('Error streaming:', error.message);
    res.status(500).json({ error: 'Error en streaming' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Descarga directa (optimizada) - CORREGIDO
app.get('/download/:id', async (req, res) => {
  const videoId = req.params.id;
  const format = req.query.format || 'mp3';
  
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    
    // Verificar si el video es válido
    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'URL de video inválida' });
    }
    
    const info = await ytdl.getInfo(url, {
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      }
    });
    
    // Limpiar el título para el nombre del archivo
    const cleanTitle = info.videoDetails.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').substring(0, 100);
    const filename = `${cleanTitle}.${format}`;
    
    // Configurar headers según el formato
    if (format === 'mp3') {
      res.setHeader('Content-Type', 'audio/mpeg');
    } else if (format === 'flac') {
      res.setHeader('Content-Type', 'audio/flac');
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
    }
    
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache');
    
    const audioStream = ytdl(url, { 
      quality: 'highestaudio',
      filter: 'audioonly',
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      }
    });
    
    // Manejar errores en el stream
    audioStream.on('error', (error) => {
      console.error('Error en audioStream:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error durante la descarga' });
      }
    });
    
    audioStream.pipe(res);
    
  } catch (error) {
    console.error('Error descarga:', error.message);
    
    if (error.message.includes('Video unavailable')) {
      return res.status(404).json({ error: 'Video no disponible' });
    } else if (error.message.includes('private')) {
      return res.status(403).json({ error: 'Video privado' });
    }
    
    res.status(500).json({ error: 'Error en descarga' });
  }
});

// API de sugerencias en tiempo real
app.get('/api/suggestions', async (req, res) => {
  const query = req.query.q;
  
  if (!query || query.length < 2) {
    return res.json([]);
  }

  const cacheKey = `suggestions:${query}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    // Búsqueda rápida solo de títulos
    const results = await ytsr(query, { limit: 5 });
    const suggestions = results.items
      .filter(item => item.type === 'video')
      .map(item => ({
        title: item.title,
        channel: item.author?.name
      }));

    cache.set(cacheKey, suggestions, 1800); // 30 minutos
    res.json(suggestions);

  } catch (error) {
    res.json([]);
  }
});

// Endpoint de salud
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    cache_size: cache.keys().length,
    memory: process.memoryUsage()
  });
});

// Manejo de errores
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// Iniciar servidor
app.listen(port, () => {
  console.log(`🚀 Servidor Node.js ejecutándose en http://localhost:${port}`);
  console.log(`⚡ Optimizado para máxima velocidad`);
  console.log(`💾 Cache activo para resultados instantáneos`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Cerrando servidor...');
  cache.flushAll();
  process.exit(0);
});

module.exports = app;