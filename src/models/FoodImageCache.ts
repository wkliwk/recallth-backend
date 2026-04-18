import { Schema, model } from 'mongoose';

interface IFoodImageCache {
  key: string;       // normalised dish name (lowercase, trimmed)
  imageUrl: string | null;
  createdAt: Date;
}

const FoodImageCacheSchema = new Schema<IFoodImageCache>({
  key: { type: String, required: true, unique: true, index: true },
  imageUrl: { type: String, default: null },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 }, // 30-day TTL
});

export const FoodImageCache = model<IFoodImageCache>('FoodImageCache', FoodImageCacheSchema);
