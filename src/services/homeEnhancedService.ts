import axios from 'axios';
import { type Song } from './jiosaavnApi';
import { metadataResolver } from './metadataResolver';
const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export class HomeEnhancedService {
  async getEnhancedSection(sectionType: string, limit: number = 30): Promise<Song[]> {
    try {
      const resp = await axios.get(`${API_BASE}/api/home/enhanced/${sectionType}`, {
        params: { limit },
        timeout: 15000,
      });

      const songs = resp.data?.songs || [];
      
      // Verify metadata if needed
      return metadataResolver.verifyHomePageMetadata(songs);
    } catch (err) {
      console.warn(`[HomeEnhancedService] Failed to fetch section ${sectionType}:`, err);
      return [];
    }
  }
}

export const homeEnhancedService = new HomeEnhancedService();
