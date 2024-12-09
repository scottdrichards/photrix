<script>
defineProps<{
    imageUrls: string[]
}>()
</script>

<template>
    <div class="gallery">
        <div v-for="imageUrl in imageUrls" :key="imageUrl" class="thumbnail">
            <img :src="imageUrl" alt="Thumbnail" />
        </div>
    </div>
</template>

<style>
.gallery {
    display: flex;
    flex-wrap: wrap;
}

.thumbnail {
    flex: 0 0 25%;
    padding: 10px;
}

.thumbnail img {
    width: 100%;
    height: auto;
}
</style>