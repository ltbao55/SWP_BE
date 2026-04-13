package com.swp391.datalabeling.service;

import com.swp391.datalabeling.dto.request.AnnotationRequest;
import com.swp391.datalabeling.dto.request.ReviewRequest;
import com.swp391.datalabeling.dto.request.TaskAssignRequest;
import com.swp391.datalabeling.entity.*;
import com.swp391.datalabeling.enums.DataItemStatus;
import com.swp391.datalabeling.enums.ReviewStatus;
import com.swp391.datalabeling.enums.TaskStatus;
import com.swp391.datalabeling.exception.BadRequestException;
import com.swp391.datalabeling.exception.ResourceNotFoundException;
import com.swp391.datalabeling.repository.*;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
@RequiredArgsConstructor
public class TaskService {

    private final TaskRepository taskRepository;
    private final DataItemRepository dataItemRepository;
    private final UserRepository userRepository;
    private final AnnotationRepository annotationRepository;
    private final ReviewRepository reviewRepository;
    private final LabelClassRepository labelClassRepository;

    public List<Task> getTasksByAnnotator(Long annotatorId) {
        return taskRepository.findByAssignedToId(annotatorId);
    }

    public List<Task> getTasksByProject(Long projectId) {
        return taskRepository.findByProjectId(projectId);
    }

    public Task getTaskById(Long id) {
        return taskRepository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("Task", id));
    }

    @Transactional
    public Task assignTask(TaskAssignRequest request) {
        DataItem dataItem = dataItemRepository.findById(request.getDataItemId())
                .orElseThrow(() -> new ResourceNotFoundException("DataItem", request.getDataItemId()));

        User annotator = userRepository.findById(request.getAnnotatorId())
                .orElseThrow(() -> new ResourceNotFoundException("User", request.getAnnotatorId()));

        if (dataItem.getTask() != null) {
            throw new BadRequestException("Data item is already assigned");
        }

        Task task = Task.builder()
                .dataItem(dataItem)
                .assignedTo(annotator)
                .status(TaskStatus.ASSIGNED)
                .build();

        dataItem.setStatus(DataItemStatus.IN_PROGRESS);
        dataItemRepository.save(dataItem);

        return taskRepository.save(task);
    }

    @Transactional
    public Task submitTask(Long taskId, List<AnnotationRequest> annotationRequests, String annotatorUsername) {
        Task task = getTaskById(taskId);

        if (!task.getAssignedTo().getUsername().equals(annotatorUsername)) {
            throw new BadRequestException("You are not assigned to this task");
        }
        if (task.getStatus() == TaskStatus.SUBMITTED || task.getStatus() == TaskStatus.APPROVED) {
            throw new BadRequestException("Task already submitted or approved");
        }

        // Clear old annotations and save new ones
        annotationRepository.deleteByTaskId(taskId);

        for (AnnotationRequest req : annotationRequests) {
            LabelClass labelClass = labelClassRepository.findById(req.getLabelClassId())
                    .orElseThrow(() -> new ResourceNotFoundException("LabelClass", req.getLabelClassId()));

            Annotation annotation = Annotation.builder()
                    .task(task)
                    .labelClass(labelClass)
                    .annotationData(req.getAnnotationData())
                    .annotationType(req.getAnnotationType())
                    .build();
            annotationRepository.save(annotation);
        }

        task.setStatus(TaskStatus.SUBMITTED);
        task.getDataItem().setStatus(DataItemStatus.SUBMITTED);
        dataItemRepository.save(task.getDataItem());

        return taskRepository.save(task);
    }

    @Transactional
    public Review reviewTask(Long taskId, ReviewRequest request, String reviewerUsername) {
        Task task = getTaskById(taskId);

        if (task.getStatus() != TaskStatus.SUBMITTED) {
            throw new BadRequestException("Task must be in SUBMITTED status to be reviewed");
        }

        User reviewer = userRepository.findByUsername(reviewerUsername)
                .orElseThrow(() -> new ResourceNotFoundException("Reviewer not found: " + reviewerUsername));

        Review review = Review.builder()
                .task(task)
                .reviewer(reviewer)
                .status(request.getStatus())
                .comment(request.getComment())
                .errorCategory(request.getErrorCategory())
                .build();

        if (request.getStatus() == ReviewStatus.APPROVED) {
            task.setStatus(TaskStatus.APPROVED);
            task.getDataItem().setStatus(DataItemStatus.APPROVED);
        } else {
            task.setStatus(TaskStatus.REJECTED);
            task.getDataItem().setStatus(DataItemStatus.REJECTED);
        }

        dataItemRepository.save(task.getDataItem());
        taskRepository.save(task);

        return reviewRepository.save(review);
    }

    public List<Task> getSubmittedTasks() {
        return taskRepository.findByStatus(TaskStatus.SUBMITTED);
    }
}
