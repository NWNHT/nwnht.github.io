#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "cJSON.h"

#define JSONFILENAME "../photolist.json"
#define INPUTBUFFERSIZE 256

#ifdef cJSON__h
  #define INCLUDED 1
#else
  #define INCLUDED 0
#endif

// Create function to reorder based on identifier?
// - Identifiers in multiples of 10 and you can reassign, then refactor?


cJSON *GetJSONObject(char *filename);
int AddPhoto(cJSON *json);
int RemovePhoto(cJSON *json);
int EditPhoto(cJSON *json);
int ListPhotos(cJSON *json);
int SaveJSON(cJSON *json, char *filename);

void PrintJSON(cJSON *json);
void PrintHR(void);
int GetFilepath(char *buffer);
int GetStringInput(char *buffer);
int GetHighestIdentifier(cJSON *json);
cJSON *PhotoPointerByIdentifier(cJSON *json, int identifier);
int PhotoIndexByIdentifier(cJSON *json, int identifier);
void EditItemInObject(cJSON* json, char *item);


int main(void) {
	// Check that the library was properly included
	if (INCLUDED) {
		printf("Library included.\n");
	} else {
		printf("Library not included.\n");
	}

	// Open file and check successful
	cJSON *json = GetJSONObject(JSONFILENAME);
	if (json == NULL) {
		return 1;
	} else {
		printf("JSON successfully parsed.\n");
	}

	// Get the photos array
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
		PrintHR();
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
		PrintHR();

		// Switch on character
		switch (c) {
			case 'a':
				// Add photo
				AddPhoto(photos);
				break;
			case 'r':
				// Remove photo
				RemovePhoto(photos);
				break;
			case 'e':
				// Edit photo
				EditPhoto(photos);
				break;
			case 'l':
				// Hopefully list photos
				ListPhotos(photos);
				break;
			case 's':
				// Write and quit
				printf("Saving and Quitting.\n");
				printf("Wrote %d characters.\n", SaveJSON(json, JSONFILENAME));
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


// Given filename, open if possible and return non-null json pointer
// This will require cleanup with free()
cJSON *GetJSONObject(char *filename) {

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
int AddPhoto(cJSON *json) {

	// Create Photo object
	cJSON *photo = cJSON_CreateObject();

	// Get the highest identifier from existing photos
	int max = GetHighestIdentifier(json);

	// Get src, alt, and caption, add strings to object
	char inputBuffer[INPUTBUFFERSIZE];
	printf("The identifier will be: %d\n", (max + 1));
	GetFilepath(inputBuffer);
	cJSON_AddStringToObject(photo, "src", inputBuffer);

	printf("Enter the 'alt': ");
	GetStringInput(inputBuffer);
	cJSON_AddStringToObject(photo, "alt", inputBuffer);

	printf("Enter the caption: ");
	GetStringInput(inputBuffer);
	cJSON_AddStringToObject(photo, "caption", inputBuffer);

	cJSON_AddNumberToObject(photo, "identifier", max + 1);

	// Add Photo Item to Photos Array
	cJSON_AddItemToArray(json, photo);

	return max + 1;
}


// Remove photo by identifier
int RemovePhoto(cJSON *json) {

	// Request identifier from user
	int identifierToRemove;
	printf("Enter the identifier of the photo to remove: ");
	scanf("%d", &identifierToRemove);
	printf("Removing item %d.\n", identifierToRemove);

	int indexToRemove = PhotoIndexByIdentifier(json, identifierToRemove);
	if (indexToRemove == -1) {
		printf("Could not find photo with identifier %d.\n", identifierToRemove);
		return -1;
	} else {
		cJSON_DeleteItemFromArray(json, indexToRemove);
		printf("Photo removed.\n");
		return indexToRemove;
	}
}


// Edit photo by identifier
int EditPhoto(cJSON *json) {
	printf("This function has not been implemented yet.\n");
	// ReplaceItemInArray or ReplaceItemViaPointer or ReplaceItemInObjectCaseSensitive

	// Request identifier from user
	int identifierToEdit;
	printf("Enter the identifier of the photo to edit: ");
	scanf("%d", &identifierToEdit);
	printf("Selecting item %d.\n", identifierToEdit);

	cJSON *itemToEdit = PhotoPointerByIdentifier(json, identifierToEdit);
	if (itemToEdit == NULL) {
		printf("Could not find photo with identifier %d.\n", identifierToEdit);
		return -1;
	}

	// Request input on which field/item to edit
	char c = '\n';
	char discard;
	printf("Photo found, which field would you like to edit?\n"
			"[ i ] - Identifier\n"
			"[ c ] - Caption\n"
			"[ a ] - alt\n"
			"[ s ] - src\n"
			"[ q ] - Cancel Edit\n"
			"   Input: ");


	// Wait for input, condition for no newline and only accept first character
	while (c == '\n') {
		c = getchar();
	}
	while ((discard = getchar()) != '\n' && discard != EOF) {}

	// Switch on entered character, throw out to function to edit item
	switch (c) {
		case 'i':
			EditItemInObject(itemToEdit, "identifier");
			break;
		case 'c':
			EditItemInObject(itemToEdit, "caption");
			break;
		case 'a':
			EditItemInObject(itemToEdit, "alt");
			break;
		case 's':
			EditItemInObject(itemToEdit, "src");
			break;
		case 'q':
			printf("Exiting edit mode with no changes made.\n");
			return 0;
			break;
	}
	printf("Edit made to photo.\n");
	return 0;
}


// List all photos by identifier, src, alt, and caption
int ListPhotos(cJSON *json) {

	// Read through all photos and print
	cJSON *loop = json ? json->child : 0;
	int count = 0;

	printf("Photos in 'photolist.json':\n");
	while (loop) {

		printf("Identifier:\t %d\n", cJSON_GetObjectItem(loop, "identifier")->valueint);
		printf("Caption:\t %s\n", cJSON_GetObjectItem(loop, "caption")->valuestring);
		printf("alt:\t\t %s\n", cJSON_GetObjectItem(loop, "alt")->valuestring);
		printf("src:\t\t %s\n\n", cJSON_GetObjectItem(loop, "src")->valuestring);

		loop = loop->next;
		count += 1;
	}

	return count;
}

int SaveJSON(cJSON *json, char *filename) {

	// Create output and write to file
	char *output = cJSON_Print(json);
	FILE* fwrite = fopen(filename, "w+");
	int count = fprintf(fwrite, "%s", output);
	fclose(fwrite);
	return count;
}


/* Utility Functions */


// Print the json object
void PrintJSON(cJSON *json) {
	char *string = cJSON_Print(json);
	printf("%s\n", string);
	free(string);
}


// Print a divider
void PrintHR(void) {
	printf("------------------------------------------\n");
}


// Given buffer, get input for photo filepath
int GetFilepath(char *buffer) {

	char temp[100] = "/photography/photos/";
	// Request input from user with file prefix
	printf("Enter the filepath of the photo:\n/photography/photos/");
	fgets(buffer, INPUTBUFFERSIZE, stdin);
	buffer[strcspn(buffer, "\n")] = 0;

	// Prepend the path and copy back to buffer
	strcat(temp, buffer);
	memcpy(buffer, temp, 100 * sizeof(char));

	return strlen(buffer);
}


// Given buffer, get alt or caption input
int GetStringInput(char *buffer) {
	// Request input to given buffer and return
	// Apparently it space terminates if you just use "%s"?
	fgets(buffer, INPUTBUFFERSIZE, stdin);
	buffer[strcspn(buffer, "\n")] = 0;
	return strlen(buffer);
}


// Return the highest identifier of the photos
int GetHighestIdentifier(cJSON *json) {
	int max = 1;
	cJSON *loop = json ? json->child : 0;

	while (loop) {
		cJSON *val = cJSON_GetObjectItem(loop, "identifier");
		if (val->valueint > max) {
			max = val->valueint;
		}
		loop = loop->next;
	}
	return max;
}


// Given json array and photo identifier, return pointer to object in array, null if not found
cJSON *PhotoPointerByIdentifier(cJSON *json, int identifier) {

	cJSON *loop = json ? json->child : 0;

	while (loop) {
		if (cJSON_GetObjectItem(loop, "identifier")->valueint == identifier) {
			return loop;
		}
		loop = loop->next;
	}
	return NULL;
}


// Given json array and photo identifier, return index of object in array, -1 if not found
int PhotoIndexByIdentifier(cJSON *json, int identifier) {

	cJSON *loop = json ? json->child : 0;
	int count = 0;

	while (loop) {
		if (cJSON_GetObjectItem(loop, "identifier")->valueint == identifier) {
			return count;
		}
		loop = loop->next;
		count += 1;
	}
	return -1;
}


// Given pointer to object, name of item, and buffer, edit the item in the photo object
void EditItemInObject(cJSON* json, char *item) {

	char buffer[INPUTBUFFERSIZE];

	if (!strcmp(item, "identifier")) {
		printf("Enter new identifier, mind existing identifiers: ");
		GetStringInput(buffer);
		cJSON_DeleteItemFromObjectCaseSensitive(json, item);
		cJSON_AddNumberToObject(json, item, atoi(buffer));
		return;
	} else if (!strcmp(item, "src")) {
		GetFilepath(buffer);
	} else {
		printf("Please enter new %s: ", item);
		GetStringInput(buffer);
	}

	cJSON_DeleteItemFromObjectCaseSensitive(json, item);
	cJSON_AddStringToObject(json, item, buffer);
}