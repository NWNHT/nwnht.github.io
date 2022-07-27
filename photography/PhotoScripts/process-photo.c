#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "cJSON.h"

#define JSONFILENAME "../photolist.json"

#ifdef cJSON__h
  #define INCLUDED 1
#else
  #define INCLUDED 0
#endif

// Create a unique identifier for the images? by reading the latest one?
// Create function to read all images from the file and prompt for caption/alt?
// Create function to remove an image by the alt or by the caption? or by the identifier
// Create function to alter caption or alt given an identifier
// Create function to reorder based on identifier?
// - Identifiers in multiples of 10 and you can reassign, then refactor?


cJSON *get_json_object(char *filename);
void print_json(cJSON *json);
int add_photo(cJSON *json);
int remove_photo(cJSON *json);
int edit_photo(cJSON *json);
int list_photos(cJSON *json);
int get_filepath(char *buffer);
int get_altcaption(char *buffer);


int main(void) {
	// Check that the library was properly included
	if (INCLUDED) {
		printf("Library included.\n");
	} else {
		printf("Library not included.\n");
	}

	// Open file and check successful
	cJSON *json = get_json_object(JSONFILENAME);
	if (json == NULL) {
		return 1;
	} else {
		printf("JSON successfully parsed.\n");
	}

	cJSON *photos = cJSON_GetObjectItemCaseSensitive(json, "photos");
	if (photos == NULL) {
		perror("Unsuccessful assignment of 'photos'.\n");
		return 1;
	}

	// Loop indefinitely(maybe until quit selected), accepting single character inputs
	while (1) {
		char c = '\n';
		char discard;

		// Print Menu
		printf("Please choose an option:\n"
				"\t[ a ] - Add Photo\n"
				"\t[ r ] - Remove Photo\n"
				"\t[ e ] - Edit Photo\n"
				"\t[ l ] - List Photos\n"
				"\t[ s ] - Write and Quit\n"
				"\t[ q ] - Quit Without Saving\n"
				"   Input: ");

		// Wait for input, condition for no newline and only accept first character
		while (c == '\n') {
			c = getchar();
		}
		while ((discard = getchar()) != '\n' && discard != EOF) {}
		printf("Character entered: %c\n", c);

		print_json(json);

		// Switch on character
		switch (c) {
			case 'a':
				// Add photo
				add_photo(photos);
				break;
			case 'r':
				// Remove photo
				remove_photo(json);
				break;
			case 'e':
				// Edit photo
				edit_photo(json);
				break;
			case 'l':
				// Hopefully list photos
				list_photos(json);
				break;
			case 's':
				// Write and quit
				printf("Saving and Quitting.\n");
				return 0;
				break;
			case 'q':
				// Quit without saving
				printf("Quitting without saving.\n");
				return 0;
				break;
			default:
				// Default option for other character
				printf("Please enter a valid option:\n");
				break;
		}
	}
	return 0;
}


// Print the json object
void print_json(cJSON *json) {
	char *string = cJSON_Print(json);
	printf("%s\n", string);
	free(string);
}


// Given filename, open if possible and return non-null json pointer
// This will require cleanup with free()
cJSON *get_json_object(char *filename) {

	// Open file 
	FILE* fp = fopen(filename, "r");
	if (fp == NULL) {
		perror("File failed to open.\n");
		return NULL;
	}

	// Read file
	char buffer[30000];
	fread(buffer, 1, 30000, fp);
	if (strlen(buffer) == 0) {
		perror("No characters read from file.\n");
		return NULL;
	} else {
		printf("Read %lu characters.\n", strlen(buffer));
	}

	// Parse JSON
	cJSON *json = cJSON_Parse(buffer);
	if (json == NULL) {
		perror("Failed to read JSON.\n");
		return NULL;
	}

	// Cleanup and return
	fclose(fp);
	return json;
}


// Add photo to json
int add_photo(cJSON *json) {

	// Three separate inputs, provide partial relative path, alt, and caption, assign identifier

	// Create Photo object
	cJSON *photo = cJSON_CreateObject();

	// Read photos to find maximum identifier
	// Loop through each array element of the json, reading the identifier element, saving the max

	// cJSON_GetArraySize and cJSON_ArrayForEach

	// TODO: This is not working quite yet, seems to fail when included
	// unsigned int max = 1;
	// cJSON_ArrayForEach(photo, json) {
	// 	cJSON *identifier = cJSON_GetObjectItemCaseSensitive(photo, "identifier");
	// 	if (identifier != NULL) {
	// 		if (identifier->valueint > max) {
	// 			max = identifier->valueint;
	// 		}
	// 	}
	// }



	// Get src, alt, and caption, add strings to object
	char inputBuffer[256];
	get_filepath(inputBuffer);
	cJSON_AddStringToObject(photo, "src", inputBuffer);

	printf("Enter the 'alt': ");
	get_altcaption(inputBuffer);
	cJSON_AddStringToObject(photo, "alt", inputBuffer);

	printf("Enter the caption: ");
	get_altcaption(inputBuffer);
	cJSON_AddStringToObject(photo, "caption", inputBuffer);

	// cJSON_AddNumberToObject(photo, "identifier", 9);

	// Add Photo Item to Photos Array
	cJSON_AddItemToArray(json, photo);

	return 0;
}


// Remove photo by identifier
int remove_photo(cJSON *json) {
	printf("This function has not been implemented yet.\n");
	return 1;
}


// Edit photo by identifier
int edit_photo(cJSON *json) {
	printf("This function has not been implemented yet.\n");
	return 1;
}


// List all photos by identifier, src, alt, and caption
int list_photos(cJSON *json) {
	printf("This function has not been implemented yet.\n");
	return 1;
}


// Given buffer, get input for photo filepath
int get_filepath(char *buffer) {

	char temp[100] = "/photography/photos/";
	// Request input from user with file prefix
	printf("Enter the filepath of the photo:\n/photography/photos/");
	scanf("%s", buffer);

	// Prepend the path and copy back to buffer
	strcat(temp, buffer);
	memcpy(buffer, temp, 100 * sizeof(char));

	return strlen(buffer);
}


// Given buffer, get alt or caption input
int get_altcaption(char *buffer) {
	scanf("%s", buffer);
	return strlen(buffer);
}


